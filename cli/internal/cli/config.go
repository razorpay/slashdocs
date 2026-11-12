package cli

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/url"
	"os"
	"path/filepath"

	"github.com/zalando/go-keyring"
)

// File permission constants for config storage.
const (
	configDirPerm  os.FileMode = 0700
	configFilePerm os.FileMode = 0600
	pulledFilePerm os.FileMode = 0644
)

type Config struct {
	ActiveContext string              `json:"active_context"`
	Contexts      map[string]*Context `json:"contexts"`
}

type Context struct {
	Server     string            `json:"server"`
	Credential map[string]any    `json:"credential,omitempty"`
	Pulled     map[string]string `json:"pulled"`
}

func configBase() string {
	if base := os.Getenv("XDG_CONFIG_HOME"); base != "" {
		return base
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config")
}

func configPath() string { return filepath.Join(configBase(), cliName, "config.json") }

func loadConfig() (Config, error) {
	c := Config{Contexts: map[string]*Context{}}
	b, err := os.ReadFile(configPath())
	if err != nil {
		// A missing config is the normal first-run state, not an error.
		return c, nil
	}
	if err := json.Unmarshal(b, &c); err != nil {
		// A present-but-corrupt config must be a hard error so mutating
		// callers abort instead of overwriting it with an empty config.
		return Config{Contexts: map[string]*Context{}}, fmt.Errorf("config %s is corrupt: %w", configPath(), err)
	}
	if c.Contexts == nil {
		c.Contexts = map[string]*Context{}
	}
	return c, nil
}

// currentContextE is like currentContext but surfaces a corrupt-config error so
// mutating callers do not clobber an unreadable config on save.
func currentContextE(g *globals) (string, *Context, Config, error) {
	cfg, err := loadConfig()
	if err != nil {
		return "", nil, Config{}, err
	}
	name, cx, cfg := currentContextFrom(g, cfg)
	return name, cx, cfg, nil
}

func saveConfig(c Config) error {
	p := configPath()
	if err := os.MkdirAll(filepath.Dir(p), configDirPerm); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, configFilePerm)
}

// serverOr returns the context's server, or fallback when the context is nil.
func (c *Context) serverOr(fallback string) string {
	if c == nil {
		return fallback
	}
	return c.Server
}

func ctxName(s string) string {
	u, err := url.Parse(normalizeServer(s))
	if err == nil && u.Host != "" {
		return u.Host
	}
	return s
}

func currentContext(g *globals) (string, *Context, Config) {
	cfg, _ := loadConfig()
	return currentContextFrom(g, cfg)
}

func currentContextFrom(g *globals, cfg Config) (string, *Context, Config) {
	srv := first(g.server, env("SLASHDOCS_SERVER"), cfg.ActiveContext)
	if srv == "" {
		// No server anywhere: hand back an unnamed, unsaved context so
		// read-only callers keep working; anything that needs a real server
		// goes through client() and fails with errNoServer.
		return "", &Context{Pulled: map[string]string{}}, cfg
	}
	name := ctxName(srv)
	cx := cfg.Contexts[name]
	if cx == nil {
		cx = &Context{Server: normalizeServer(srv), Pulled: map[string]string{}}
	}
	if cx.Pulled == nil {
		cx.Pulled = map[string]string{}
	}
	return name, cx, cfg
}

// moveContext points the saved context of oldServer at newServer, with its
// credential, and keeps it active. A context that the user already has for
// newServer wins, and the old one is removed.
func moveContext(oldServer, newServer string) error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	oldName, newName := ctxName(oldServer), ctxName(newServer)
	cx := cfg.Contexts[oldName]
	if cx == nil || oldName == newName {
		return nil
	}
	delete(cfg.Contexts, oldName)
	if cfg.ActiveContext == oldName {
		cfg.ActiveContext = newName
	}
	tok := credentialToken(oldName, cx.Credential)
	deleteCredentialToken(oldName, cx.Credential)
	if cfg.Contexts[newName] == nil {
		cx.Server = normalizeServer(newServer)
		if tok != "" {
			cred := maps.Clone(cx.Credential)
			delete(cred, "token_ref")
			cred["token"] = tok
			cx.Credential = storeCredentialToken(newName, cred)
		}
		cfg.Contexts[newName] = cx
	}
	return saveConfig(cfg)
}

const keychainService = cliName

func keychainDisabled() bool             { return env("SLASHDOCS_NO_KEYCHAIN") != "" }
func tokenRef(contextName string) string { return contextName + ":token" }

func credentialToken(contextName string, cred map[string]any) string {
	if cred == nil {
		return ""
	}
	if t, ok := cred["token"].(string); ok && t != "" {
		return t
	}
	ref, _ := cred["token_ref"].(string)
	if ref == "" {
		ref = tokenRef(contextName)
	}
	if keychainDisabled() {
		return ""
	}
	if t, err := keyring.Get(keychainService, ref); err == nil {
		return t
	}
	// Tokens saved before the rename live under the aidocs service. Move them.
	t, err := keyring.Get(legacyName, ref)
	if err != nil {
		return ""
	}
	if keyring.Set(keychainService, ref, t) == nil {
		_ = keyring.Delete(legacyName, ref)
	}
	return t
}

func storeCredentialToken(contextName string, cred map[string]any) map[string]any {
	if cred == nil {
		return cred
	}
	tok, _ := cred["token"].(string)
	if tok == "" {
		return cred
	}
	if keychainDisabled() {
		return cred
	}
	ref := tokenRef(contextName)
	if err := keyring.Set(keychainService, ref, tok); err != nil {
		return cred
	}
	delete(cred, "token")
	cred["token_ref"] = ref
	return cred
}

func deleteCredentialToken(contextName string, cred map[string]any) {
	if keychainDisabled() {
		return
	}
	ref := tokenRef(contextName)
	if cred != nil {
		if r, ok := cred["token_ref"].(string); ok && r != "" {
			ref = r
		}
	}
	// A token saved before the rename may still be under the aidocs service.
	for _, service := range []string{keychainService, legacyName} {
		_ = keyring.Delete(service, ref)
	}
}

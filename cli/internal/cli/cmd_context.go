package cli

import (
	"encoding/json"
	"io"
	"maps"

	"github.com/spf13/cobra"
)

func contextCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "context", Short: "Manage saved server contexts"}
	c.AddCommand(&cobra.Command{Use: "list", Short: "List saved contexts", RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := loadConfig()
		if err != nil {
			return err
		}
		// A token stored in the config file is a secret, so the list leaves it out.
		contexts := map[string]Context{}
		for name, cx := range cfg.Contexts {
			listed := *cx
			listed.Credential = maps.Clone(cx.Credential)
			delete(listed.Credential, "token")
			contexts[name] = listed
		}
		b, err := json.Marshal(map[string]any{"active_context": cfg.ActiveContext, "contexts": contexts})
		if err != nil {
			return err
		}
		return render(out, g, b)
	}}, &cobra.Command{Use: "use <server>", Short: "Switch the active context", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		server, err := serverURL(args[0])
		if err != nil {
			return err
		}
		cfg, err := loadConfig()
		if err != nil {
			return err
		}
		name := ctxName(server)
		if cfg.Contexts[name] == nil {
			cfg.Contexts[name] = &Context{Server: server, Pulled: map[string]string{}}
		}
		cfg.ActiveContext = name
		if err := saveConfig(cfg); err != nil {
			return err
		}
		return confirm(out, g, "Switched to context "+name+".")
	}})
	return c
}

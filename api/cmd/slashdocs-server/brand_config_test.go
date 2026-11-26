package main

import (
	"errors"
	"io/fs"
	"strings"
	"testing"
)

func TestLoadBrandReadsSettingsAndFiles(t *testing.T) {
	env := map[string]string{
		"SLASHDOCS_BRAND_NAME":           "Acme Artifacts",
		"SLASHDOCS_BRAND_ACCENT_COLOR":   "#c94a00",
		"SLASHDOCS_BRAND_LOGO_FILE":      "/brand/logo.svg",
		"SLASHDOCS_BRAND_LOGO_DARK_FILE": "/brand/logo-dark.svg",
	}
	files := map[string]string{
		"/brand/logo.svg":      `<svg xmlns="http://www.w3.org/2000/svg"/>`,
		"/brand/logo-dark.svg": `<svg xmlns="http://www.w3.org/2000/svg"/>`,
	}
	brand, err := loadBrand(func(k string) string { return env[k] }, func(path string) ([]byte, error) {
		body, ok := files[path]
		if !ok {
			return nil, fs.ErrNotExist
		}
		return []byte(body), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if brand.ProductName() != "Acme Artifacts" {
		t.Fatalf("ProductName = %q", brand.ProductName())
	}
}

func TestLoadBrandWithoutSettingsKeepsSlashdocs(t *testing.T) {
	brand, err := loadBrand(func(string) string { return "" }, func(string) ([]byte, error) {
		return nil, errors.New("no file should be read")
	})
	if err != nil || brand.ProductName() != "slashdocs" {
		t.Fatalf("brand = %q, err = %v", brand.ProductName(), err)
	}
}

func TestLoadBrandStopsOnAMissingOrInvalidFile(t *testing.T) {
	for name, tc := range map[string]struct {
		body string
		read error
		want string
	}{
		"missing file": {read: fs.ErrNotExist, want: "SLASHDOCS_BRAND_LOGO_FILE"},
		"not an SVG":   {body: "<html/>", want: "want <svg>"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := loadBrand(func(k string) string {
				if k == "SLASHDOCS_BRAND_LOGO_FILE" {
					return "/brand/logo.svg"
				}
				return ""
			}, func(string) ([]byte, error) { return []byte(tc.body), tc.read })
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}
}

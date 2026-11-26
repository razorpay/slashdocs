package testdb_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

const testdbImportPath = "github.com/razorpay/slashdocs/api/internal/testdb"

// TestEveryTestdbUserRemovesItsContainer guards against leaked PostgreSQL
// containers: a package whose tests call testdb without running them through
// testdb.Main leaves its container behind whenever testcontainers' reaper is
// unavailable, once per test run.
func TestEveryTestdbUserRemovesItsContainer(t *testing.T) {
	root := moduleRoot(t)
	usesTestdb := map[string]bool{}
	callsMain := map[string]bool{}
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if path != root && (strings.HasPrefix(name, ".") || name == "node_modules" || name == "vendor" || name == "testdata") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		alias, ok := testdbImportName(file)
		if !ok {
			return nil
		}
		dir, _ := filepath.Rel(root, filepath.Dir(path))
		usesTestdb[dir] = true
		if declaresTestMainCalling(file, alias) {
			callsMain[dir] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scan test files: %v", err)
	}
	if len(usesTestdb) == 0 {
		t.Fatal("found no tests that use testdb; the scan is broken")
	}

	var missing []string
	for dir := range usesTestdb {
		if !callsMain[dir] {
			missing = append(missing, dir)
		}
	}
	sort.Strings(missing)
	for _, dir := range missing {
		t.Errorf("%s: tests use testdb but no TestMain calls testdb.Main; add\n\tfunc TestMain(m *testing.M) { testdb.Main(m) }", dir)
	}
}

// moduleRoot returns the directory holding go.mod, searching upwards from the
// package directory the test runs in.
func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found above the test directory")
		}
		dir = parent
	}
}

// testdbImportName reports the name under which file imports testdb.
func testdbImportName(file *ast.File) (string, bool) {
	for _, imp := range file.Imports {
		path, err := strconv.Unquote(imp.Path.Value)
		if err != nil || path != testdbImportPath {
			continue
		}
		if imp.Name != nil {
			return imp.Name.Name, true
		}
		return "testdb", true
	}
	return "", false
}

// declaresTestMainCalling reports whether file declares TestMain and calls
// <alias>.Main inside it.
func declaresTestMainCalling(file *ast.File, alias string) bool {
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv != nil || fn.Name.Name != "TestMain" || fn.Body == nil {
			continue
		}
		found := false
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "Main" {
				return true
			}
			if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == alias {
				found = true
			}
			return !found
		})
		if found {
			return true
		}
	}
	return false
}

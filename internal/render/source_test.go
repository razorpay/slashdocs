package render

import (
	"regexp"
	"strings"
	"testing"
)

var sourceAttrPattern = regexp.MustCompile(` ` + sourceAttr + `="\d+"`)

func TestTagSourceMarksEveryStartTagWithItsUTF16Offset(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"plain", `<p>a</p><br/>`,
			`<p data-slashdocs-source="0">a</p><br data-slashdocs-source="8"/>`},
		// é is 2 bytes and 1 code unit, an emoji 4 bytes and 2 code units.
		{"multi-byte text", `<p>é😀</p><b>x</b>`,
			`<p data-slashdocs-source="0">é😀</p><b data-slashdocs-source="10">x</b>`},
		{"leading BOM", "\ufeff<p>x</p>",
			"\ufeff<p data-slashdocs-source=\"1\">x</p>"},
		{"invalid byte", "\xff<p>x</p>",
			"\xff<p data-slashdocs-source=\"1\">x</p>"},
		{"uppercase and attributes", `<DIV Class="a">x</DIV><img src=x alt='a>b'>`,
			`<DIV data-slashdocs-source="0" Class="a">x</DIV><img data-slashdocs-source="22" src=x alt='a>b'>`},
		{"comments and doctype", `<!doctype html><!-- <p> --><p>x</p>`,
			`<!doctype html><!-- <p> --><p data-slashdocs-source="27">x</p>`},
		{"raw text elements", `<script>if (a<b) "<p>"</script><style>a>b{}</style><title><i></title><textarea><b></textarea><p>x</p>`,
			`<script data-slashdocs-source="0">if (a<b) "<p>"</script><style data-slashdocs-source="31">a>b{}</style><title data-slashdocs-source="51"><i></title><textarea data-slashdocs-source="69"><b></textarea><p data-slashdocs-source="93">x</p>`},
		{"self-closing with a newline after the name", "<svg\n/><input\tvalue=\"<\">",
			"<svg data-slashdocs-source=\"0\"\n/><input data-slashdocs-source=\"7\"\tvalue=\"<\">"},
		{"unterminated tag", `<p>x</p><b`, `<p data-slashdocs-source="0">x</p><b`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := string(tagSource([]byte(tc.in)))
			if got != tc.want {
				t.Fatalf("tagSource(%q)\n got %q\nwant %q", tc.in, got, tc.want)
			}
			if back := sourceAttrPattern.ReplaceAllString(got, ""); back != tc.in {
				t.Fatalf("without the attributes = %q, want the input %q", back, tc.in)
			}
		})
	}
}

func TestRenderWrapperTagsTheUserHTMLOnly(t *testing.T) {
	out := string(Wrap([]byte(`<html><head></head><body><p>x</p></body></html>`), "https://app.example"))
	for _, needle := range []string{
		`&lt;html data-slashdocs-source=&#34;0&#34;&gt;&lt;head data-slashdocs-source=&#34;6&#34;&gt;&lt;script id=&#34;slashdocs-bootstrap&#34;&gt;`,
		`&lt;p data-slashdocs-source=&#34;25&#34;&gt;x`,
	} {
		if !strings.Contains(out, needle) {
			t.Fatalf("wrapper is missing %q: %s", needle, out)
		}
	}
	if strings.Count(out, sourceAttr) != 4 {
		t.Fatalf("wrapper tags more than the four user elements: %s", out)
	}
}

package render

import (
	"reflect"
	"testing"
)

func TestHeadingIDsReserveAllExplicitIDs(t *testing.T) {
	items, err := Headings([]byte(`<div id="rollout"></div><h2>Rollout</h2><h2 id="rollout-2">Explicit</h2><h2>Rollout</h2><h3>你好</h3><h3>Hello &amp; world</h3><template><h1>Ignored</h1></template>`))
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, h := range items {
		ids = append(ids, h.ID)
	}
	if !reflect.DeepEqual(ids, []string{"rollout-3", "rollout-2", "rollout-4", "section", "hello-world"}) {
		t.Fatalf("ids=%v", ids)
	}
	if items[4].Text != "Hello & world" || items[4].Level != 3 {
		t.Fatalf("heading=%#v", items[4])
	}
}

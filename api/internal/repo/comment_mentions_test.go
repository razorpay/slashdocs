package repo

import (
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

func validateCommentMentions(body string, mentions []CommentMention) ([]CommentMention, error) {
	ordered, err := ValidateCommentMentionRanges(body, mentions)
	if err != nil {
		return nil, err
	}
	for _, mention := range ordered {
		if !CommentMentionMatchesCanonicalLabel(mention) {
			return nil, invalidMention("range does not exactly match the principal label")
		}
	}
	return ordered, nil
}

func TestNormalizeCommentBody(t *testing.T) {
	t.Parallel()
	const marker = "\u2063"
	if got := NormalizeCommentBody(marker + "@Alice" + marker + " and " + marker + "@Bob" + marker); got != "@Alice and @Bob" {
		t.Fatalf("NormalizeCommentBody() = %q", got)
	}
	if got := NormalizeCommentBody(marker); got != "" {
		t.Fatalf("marker-only body normalized to %q, want empty", got)
	}
}

func TestValidateCommentMentionsUsesUTF16AndSortsWithoutMutating(t *testing.T) {
	t.Parallel()
	user := auth.Principal{Type: auth.PrincipalUser, ID: "usr_admin", Email: "admin@example.com", Name: "Admin"}
	serviceAccount := auth.Principal{Type: auth.PrincipalServiceAccount, ID: "sa_review", Name: "review-bot"}
	body := "🙂 ping @admin@example.com and @review-bot"
	input := []CommentMention{
		{Principal: serviceAccount, OffsetUTF16: 31, LengthUTF16: 11},
		{Principal: user, OffsetUTF16: 8, LengthUTF16: 18},
	}
	original := append([]CommentMention(nil), input...)

	got, err := validateCommentMentions(body, input)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(input, original) {
		t.Fatalf("validator mutated input\n got: %#v\nwant: %#v", input, original)
	}
	if len(got) != 2 || got[0].OffsetUTF16 != 8 || got[1].OffsetUTF16 != 31 {
		t.Fatalf("ordered mentions = %#v", got)
	}
	if got[0].LabelText != "@admin@example.com" || got[1].LabelText != "@review-bot" {
		t.Fatalf("label snapshots = %q, %q", got[0].LabelText, got[1].LabelText)
	}

	empty, err := ValidateCommentMentionRanges("plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	if empty == nil || len(empty) != 0 {
		t.Fatalf("empty mentions = %#v, want non-nil empty slice", empty)
	}
}

func TestValidateCommentMentionsAcceptsCanonicalAliasesAndMultipleRanges(t *testing.T) {
	t.Parallel()
	user := auth.Principal{Type: auth.PrincipalUser, ID: "usr_1", Email: "alice@example.com", Name: "Alice"}
	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "name", body: "@Alice"},
		{name: "email", body: "@alice@example.com"},
		{name: "id", body: "@usr_1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if _, err := validateCommentMentions(tc.body, []CommentMention{{Principal: user, LengthUTF16: int64(len(tc.body))}}); err != nil {
				t.Fatal(err)
			}
		})
	}

	body := "@Alice @Bob"
	mentions := []CommentMention{
		{Principal: user, OffsetUTF16: 0, LengthUTF16: 6},
		{Principal: auth.Principal{Type: auth.PrincipalUser, ID: "usr_bob", Name: "Bob"}, OffsetUTF16: 7, LengthUTF16: 4},
	}
	if _, err := validateCommentMentions(body, mentions); err != nil {
		t.Fatalf("multiple ranges rejected: %v", err)
	}
}

func TestValidateCommentMentionsRejectsMalformedRanges(t *testing.T) {
	t.Parallel()
	user := auth.Principal{Type: auth.PrincipalUser, ID: "usr_alice", Name: "Alice"}
	valid := CommentMention{Principal: user, OffsetUTF16: 0, LengthUTF16: 6}
	tests := []struct {
		name     string
		body     string
		mentions []CommentMention
		ranges   bool
	}{
		{name: "negative offset", body: "@Alice", mentions: []CommentMention{{Principal: user, OffsetUTF16: -1, LengthUTF16: 6}}},
		{name: "offset exceeds postgres integer", body: "@Alice", mentions: []CommentMention{{Principal: user, OffsetUTF16: int64(math.MaxInt32) + 1, LengthUTF16: 1}}},
		{name: "zero length", body: "@Alice", mentions: []CommentMention{{Principal: user, LengthUTF16: 0}}},
		{name: "negative length", body: "@Alice", mentions: []CommentMention{{Principal: user, LengthUTF16: -1}}},
		{name: "length exceeds postgres integer", body: "@Alice", mentions: []CommentMention{{Principal: user, LengthUTF16: int64(math.MaxInt32) + 1}}},
		{name: "outside body", body: "@Alice", mentions: []CommentMention{{Principal: user, OffsetUTF16: 0, LengthUTF16: 7}}},
		{name: "start splits surrogate pair", body: "🙂 @Alice", mentions: []CommentMention{{Principal: user, OffsetUTF16: 1, LengthUTF16: 1}}},
		{name: "end splits surrogate pair", body: "🙂 @Alice", mentions: []CommentMention{{Principal: user, OffsetUTF16: 0, LengthUTF16: 1}}},
		{name: "duplicate overlapping range", body: "@Alice", mentions: []CommentMention{valid, valid}},
		{name: "missing at sign", body: "Alice", mentions: []CommentMention{{Principal: user, LengthUTF16: 5}}, ranges: true},
		{name: "only at sign", body: "@", mentions: []CommentMention{{Principal: user, LengthUTF16: 1}}, ranges: true},
		{name: "embedded at start", body: "x@Alice", mentions: []CommentMention{{Principal: user, OffsetUTF16: 1, LengthUTF16: 6}}},
		{name: "embedded at end", body: "@Alicex", mentions: []CommentMention{valid}},
		{name: "underscore suffix spoof", body: "@Alice_evil", mentions: []CommentMention{valid}},
		{name: "apostrophe suffix spoof", body: "@Alice'evil", mentions: []CommentMention{valid}},
		{name: "email domain suffix spoof", body: "@alice@example.com.evil", mentions: []CommentMention{{Principal: auth.Principal{Type: auth.PrincipalUser, ID: "usr_alice", Email: "alice@example.com"}, LengthUTF16: 18}}},
		{name: "fullwidth full stop suffix spoof", body: "@Alice．evil", mentions: []CommentMention{valid}},
		{name: "connector punctuation suffix spoof", body: "@Alice‿evil", mentions: []CommentMention{valid}},
		{name: "punctuation run before text", body: "@Alice…!evil", mentions: []CommentMention{valid}},
		{name: "punctuation run before symbol", body: "@Alice…”$", mentions: []CommentMention{valid}},
		{name: "anyone principal", body: "@Alice", mentions: []CommentMention{{Principal: auth.Principal{Type: auth.PrincipalAnyone, ID: "any"}, LengthUTF16: 6}}},
		{name: "anonymous principal", body: "@Alice", mentions: []CommentMention{{Principal: auth.Principal{Type: auth.PrincipalAnonymous, ID: "anon"}, LengthUTF16: 6}}},
		{name: "missing principal id", body: "@Alice", mentions: []CommentMention{{Principal: auth.Principal{Type: auth.PrincipalUser, Name: "Alice"}, LengthUTF16: 6}}},
		{name: "wrong canonical label", body: "@Mallory", mentions: []CommentMention{{Principal: user, LengthUTF16: 8}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var err error
			if tc.ranges {
				_, err = ValidateCommentMentionRanges(tc.body, tc.mentions)
			} else {
				_, err = validateCommentMentions(tc.body, tc.mentions)
			}
			if !errors.Is(err, ErrInvalidCommentMention) {
				t.Fatalf("error = %v, want ErrInvalidCommentMention", err)
			}
		})
	}

	invalidUTF8 := string([]byte{0xff, '@', 'A'})
	if _, err := ValidateCommentMentionRanges(invalidUTF8, nil); !errors.Is(err, ErrInvalidCommentMention) {
		t.Fatalf("invalid UTF-8 error = %v", err)
	}

	for _, body := range []string{"@Alice.", "@Alice, next", "@Alice…” next"} {
		if _, err := validateCommentMentions(body, []CommentMention{valid}); err != nil {
			t.Fatalf("terminal punctuation in %q rejected: %v", body, err)
		}
	}
}

func TestValidateCommentMentionsCapsWorkBeforeOtherValidation(t *testing.T) {
	t.Parallel()
	principal := auth.Principal{Type: auth.PrincipalUser, ID: "usr_cap"}
	body, fifty := repeatedMentions(principal, MaxCommentMentions)
	if got, err := validateCommentMentions(body, fifty); err != nil || len(got) != MaxCommentMentions {
		t.Fatalf("50 mentions = %d, %v", len(got), err)
	}

	_, fiftyOne := repeatedMentions(auth.Principal{Type: auth.PrincipalAnyone}, MaxCommentMentions+1)
	_, err := ValidateCommentMentionRanges("", fiftyOne)
	if !errors.Is(err, ErrInvalidCommentMention) || !strings.Contains(err.Error(), "too many mentions") {
		t.Fatalf("51 mentions error = %v, want cheap count rejection", err)
	}
}

func repeatedMentions(principal auth.Principal, count int) (string, []CommentMention) {
	label := "@" + principal.ID
	var body strings.Builder
	mentions := make([]CommentMention, 0, count)
	var offset int64
	for i := 0; i < count; i++ {
		if i > 0 {
			body.WriteByte(' ')
			offset++
		}
		body.WriteString(label)
		mentions = append(mentions, CommentMention{Principal: principal, OffsetUTF16: offset, LengthUTF16: int64(len(label))})
		offset += int64(len(label))
	}
	return body.String(), mentions
}

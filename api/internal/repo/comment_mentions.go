package repo

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

// MaxCommentMentions bounds validation, principal lookups, and inserts for one
// comment write.
const MaxCommentMentions = 50

// NormalizeCommentBody removes the legacy in-band U+2063 mention marker. The
// database trigger applies the same normalization as a backstop for old servers
// and direct SQL writers during rolling upgrades.
func NormalizeCommentBody(body string) string {
	return strings.ReplaceAll(body, "\u2063", "")
}

// ValidateCommentMentionRanges performs all cheap structural validation and
// returns a deterministically sorted copy. It snapshots each exact visible
// @label into LabelText before any principal database lookup is necessary.
// Offsets and lengths are UTF-16 code units; byte and rune indexes are
// deliberately never compared with them directly.
func ValidateCommentMentionRanges(body string, mentions []CommentMention) ([]CommentMention, error) {
	if len(mentions) > MaxCommentMentions {
		return nil, invalidMention("too many mentions")
	}
	if !utf8.ValidString(body) {
		return nil, invalidMention("comment body is not valid UTF-8")
	}
	if len(mentions) == 0 {
		return make([]CommentMention, 0), nil
	}

	ordered := append(make([]CommentMention, 0, len(mentions)), mentions...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].OffsetUTF16 != ordered[j].OffsetUTF16 {
			return ordered[i].OffsetUTF16 < ordered[j].OffsetUTF16
		}
		if ordered[i].LengthUTF16 != ordered[j].LengthUTF16 {
			return ordered[i].LengthUTF16 < ordered[j].LengthUTF16
		}
		if ordered[i].Principal.Type != ordered[j].Principal.Type {
			return ordered[i].Principal.Type < ordered[j].Principal.Type
		}
		return ordered[i].Principal.ID < ordered[j].Principal.ID
	})

	endpoints, err := requestedMentionEndpoints(ordered)
	if err != nil {
		return nil, err
	}
	boundaries, total, err := utf16ByteOffsets(body, endpoints)
	if err != nil {
		return nil, err
	}
	for i, mention := range ordered {
		startByte, endByte, err := mentionByteRange(mention, boundaries, total)
		if err != nil {
			return nil, err
		}
		label, err := snapshotMentionLabel(body, startByte, endByte)
		if err != nil {
			return nil, err
		}
		mention.LabelText = label
		ordered[i] = mention
	}
	return ordered, nil
}

func requestedMentionEndpoints(mentions []CommentMention) (map[int64]struct{}, error) {
	endpoints := make(map[int64]struct{}, len(mentions)*2)
	var previousEnd int64
	for i, mention := range mentions {
		if err := validateMentionPrincipalRef(mention.Principal); err != nil {
			return nil, err
		}
		end, err := mentionRangeEnd(mention)
		if err != nil {
			return nil, err
		}
		if i > 0 && mention.OffsetUTF16 < previousEnd {
			return nil, invalidMention("ranges overlap")
		}
		endpoints[mention.OffsetUTF16] = struct{}{}
		endpoints[end] = struct{}{}
		previousEnd = end
	}
	return endpoints, nil
}

func validateMentionPrincipalRef(principal auth.Principal) error {
	if principal.Type != auth.PrincipalUser && principal.Type != auth.PrincipalServiceAccount {
		return invalidMention("principal type must be user or service_account")
	}
	if principal.ID == "" {
		return invalidMention("principal id is required")
	}
	return nil
}

func mentionRangeEnd(mention CommentMention) (int64, error) {
	if mention.OffsetUTF16 < 0 || mention.OffsetUTF16 > math.MaxInt32 {
		return 0, invalidMention("offset is outside the supported range")
	}
	if mention.LengthUTF16 <= 0 || mention.LengthUTF16 > math.MaxInt32 {
		return 0, invalidMention("length is outside the supported range")
	}
	if mention.LengthUTF16 > math.MaxInt64-mention.OffsetUTF16 {
		return 0, invalidMention("range overflows")
	}
	return mention.OffsetUTF16 + mention.LengthUTF16, nil
}

func mentionByteRange(mention CommentMention, boundaries map[int64]int, total int64) (startByte, endByte int, err error) {
	end := mention.OffsetUTF16 + mention.LengthUTF16
	if end > total {
		return 0, 0, invalidMention("range is outside the comment body")
	}
	startByte, startOK := boundaries[mention.OffsetUTF16]
	endByte, endOK := boundaries[end]
	if !startOK || !endOK {
		return 0, 0, invalidMention("range splits a Unicode code point")
	}
	return startByte, endByte, nil
}

func snapshotMentionLabel(body string, startByte, endByte int) (string, error) {
	if !validMentionStartBoundary(body, startByte) || !validMentionEndBoundary(body, endByte) {
		return "", invalidMention("range is not on mention text boundaries")
	}
	label := body[startByte:endByte]
	if !strings.HasPrefix(label, "@") || label == "@" {
		return "", invalidMention("range does not cover a visible @label")
	}
	return label, nil
}

func utf16ByteOffsets(body string, requested map[int64]struct{}) (map[int64]int, int64, error) {
	boundaries := make(map[int64]int, len(requested))
	if _, ok := requested[0]; ok {
		boundaries[0] = 0
	}
	var units int64
	for byteOffset := 0; byteOffset < len(body); {
		r, size := utf8.DecodeRuneInString(body[byteOffset:])
		width := utf16.RuneLen(r)
		if width < 0 {
			return nil, 0, invalidMention("comment body contains an invalid Unicode code point")
		}
		if units > math.MaxInt64-int64(width) {
			return nil, 0, invalidMention("comment body is too large")
		}
		units += int64(width)
		byteOffset += size
		if _, ok := requested[units]; ok {
			boundaries[units] = byteOffset
		}
	}
	return boundaries, units, nil
}

func validMentionStartBoundary(body string, byteOffset int) bool {
	if byteOffset == 0 {
		return true
	}
	r, _ := utf8.DecodeLastRuneInString(body[:byteOffset])
	return unicode.IsSpace(r) || strings.ContainsRune("([{", r)
}

func validMentionEndBoundary(body string, byteOffset int) bool {
	for byteOffset < len(body) {
		r, size := utf8.DecodeRuneInString(body[byteOffset:])
		if unicode.IsSpace(r) {
			return true
		}
		if !unicode.IsPunct(r) || unicode.Is(unicode.Pc, r) || isMentionTokenPunctuation(r) {
			return false
		}
		byteOffset += size
	}
	return true
}

func isMentionTokenPunctuation(r rune) bool {
	return strings.ContainsRune("_%+-@'", r)
}

// CommentMentionMatchesCanonicalLabel reports whether the stored visible label
// is the principal's current name, email, or stable ID prefixed with @.
func CommentMentionMatchesCanonicalLabel(mention CommentMention) bool {
	principal := mention.Principal
	for _, label := range []string{principal.Name, principal.Email, principal.ID} {
		if label != "" && mention.LabelText == "@"+label {
			return true
		}
	}
	return false
}

func invalidMention(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidCommentMention, reason)
}

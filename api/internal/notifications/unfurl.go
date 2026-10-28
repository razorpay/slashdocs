package notifications

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"unicode"

	"golang.org/x/net/html"
)

// Slack unfurls do not accept rich_text blocks, so text goes in mrkdwn with
// &, < and > escaped: "<!channel>" in a title cannot become a mention.

// Unfurler sends link-preview cards and tells whether a conversation includes
// another organization.
type Unfurler interface {
	Unfurl(ctx context.Context, target UnfurlTarget, unfurls map[string]any) error
	IsExternalChannel(ctx context.Context, channel string) (bool, error)
}

// UnfurlTarget is the message a card belongs to.
type UnfurlTarget struct {
	Channel, TS, UnfurlID, Source string
}

func (t UnfurlTarget) IsComposer() bool {
	return t.Source == "composer" || t.Channel == "" || t.Channel == "COMPOSER"
}

type DocCard struct {
	Title       string
	URL         string
	Owner       string
	Version     int
	OpenThreads int
	HTML        []byte
}

const (
	unfurlSummaryLimit = 160
	// summaryParseLimit matches searchText's limit.
	summaryParseLimit = 256 << 10
)

func LiveUnfurl(card DocCard) map[string]any {
	title := notificationPreview(card.Title, 150)
	if title == "" {
		title = "Untitled document"
	}
	blocks := []any{
		mrkdwnSection("*<" + card.URL + "|" + slackEscape(title) + ">*"),
	}
	// Same redaction as notifications before doc text reaches Slack.
	if summary := notificationPreview(docSummary(card.HTML, card.Title), unfurlSummaryLimit); summary != "" {
		blocks = append(blocks, mrkdwnSection(slackEscape(summary)))
	}
	var facts []string
	if card.Version > 0 {
		facts = append(facts, fmt.Sprintf("v%d", card.Version))
	}
	threads := "open threads"
	if card.OpenThreads == 1 {
		threads = "open thread"
	}
	facts = append(facts, fmt.Sprintf("%d %s", card.OpenThreads, threads))
	if owner := notificationPreview(card.Owner, 80); owner != "" {
		facts = append(facts, slackEscape(owner))
	}
	blocks = append(blocks,
		map[string]any{"type": "context", "elements": []any{
			map[string]any{"type": "mrkdwn", "text": strings.Join(facts, " · ")},
		}},
		map[string]any{"type": "actions", "elements": []any{
			map[string]any{
				"type": "button",
				"text": map[string]any{"type": "plain_text", "text": "Open doc"},
				"url":  card.URL,
			},
		}},
	)
	return map[string]any{"blocks": blocks}
}

// NeutralUnfurl names nothing, so private, missing and deleted docs look the same.
func NeutralUnfurl() map[string]any {
	return map[string]any{"blocks": []any{
		mrkdwnSection("SlashDocs document · Sign in to see if you have access"),
	}}
}

func mrkdwnSection(text string) map[string]any {
	return map[string]any{"type": "section", "text": map[string]any{"type": "mrkdwn", "text": text}}
}

func slackEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// docSummary is the meta description, then og:description, then the first
// visible text without the title.
func docSummary(doc []byte, title string) string {
	if len(doc) == 0 {
		return ""
	}
	s := summaryScanner{z: html.NewTokenizer(bytes.NewReader(doc[:min(len(doc), summaryParseLimit)]))}
	for s.text.Len() < len(title)+4*unfurlSummaryLimit {
		token := s.z.Next()
		if token == html.ErrorToken {
			break
		}
		switch token {
		case html.TextToken:
			s.addText()
		case html.StartTagToken, html.SelfClosingTagToken:
			s.startTag(token == html.SelfClosingTagToken)
		case html.EndTagToken:
			s.endTag()
		}
	}
	for _, d := range []string{s.description, s.ogDescription} {
		if d = strings.Join(strings.FieldsFunc(d, isSpaceOrControl), " "); d != "" {
			return d
		}
	}
	return firstWords(withoutTitle(s.text.String(), title), unfurlSummaryLimit)
}

type summaryScanner struct {
	z                          *html.Tokenizer
	description, ogDescription string
	text                       strings.Builder
	inHead                     bool
	hidden                     int
}

func (s *summaryScanner) addText() {
	if s.inHead || s.hidden > 0 {
		return
	}
	for _, word := range strings.FieldsFunc(string(s.z.Text()), isSpaceOrControl) {
		if s.text.Len() > 0 {
			s.text.WriteByte(' ')
		}
		s.text.WriteString(word)
	}
}

func (s *summaryScanner) startTag(selfClosing bool) {
	name, hasAttr := s.z.TagName()
	tag := string(name)
	attrs := map[string]string{}
	for hasAttr {
		var key, val []byte
		key, val, hasAttr = s.z.TagAttr()
		attrs[strings.ToLower(string(key))] = string(val)
	}
	switch tag {
	case "head":
		s.inHead = true
	case "body":
		s.inHead = false
	case "meta":
		s.readMeta(attrs)
	}
	if selfClosing || voidElements[tag] {
		return
	}
	_, hiddenAttr := attrs["hidden"]
	switch {
	case s.hidden > 0:
		s.hidden++
	case summaryHiddenElements[tag] || hiddenAttr || strings.EqualFold(attrs["aria-hidden"], "true"):
		s.hidden = 1
	}
}

func (s *summaryScanner) readMeta(attrs map[string]string) {
	if strings.EqualFold(attrs["name"], "description") && s.description == "" {
		s.description = attrs["content"]
	}
	if strings.EqualFold(attrs["property"], "og:description") && s.ogDescription == "" {
		s.ogDescription = attrs["content"]
	}
}

func (s *summaryScanner) endTag() {
	if name, _ := s.z.TagName(); string(name) == "head" {
		s.inHead = false
	}
	if s.hidden > 0 {
		s.hidden--
	}
}

var summaryHiddenElements = map[string]bool{"script": true, "style": true, "template": true, "noscript": true}

// voidElements never have an end tag, so they must not change the depth count.
var voidElements = map[string]bool{
	"area": true, "base": true, "br": true, "col": true, "embed": true, "hr": true, "img": true,
	"input": true, "link": true, "meta": true, "source": true, "track": true, "wbr": true,
}

func isSpaceOrControl(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }

// withoutTitle drops the title, since most docs open with it and the card already shows it.
func withoutTitle(text, title string) string {
	title = strings.Join(strings.FieldsFunc(title, isSpaceOrControl), " ")
	if title != "" && len(text) >= len(title) && strings.EqualFold(text[:len(title)], title) {
		text = text[len(title):]
	}
	return strings.TrimLeftFunc(text, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsPunct(r) })
}

func firstWords(text string, limit int) string {
	chars := []rune(text)
	if len(chars) <= limit {
		return text
	}
	cut := string(chars[:limit-1])
	if i := strings.LastIndexByte(cut, ' '); i > 0 {
		cut = cut[:i]
	}
	return strings.TrimRightFunc(cut, unicode.IsPunct) + "…"
}

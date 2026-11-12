package cli

import (
	"encoding/json"
	"io"
	"slices"
	"time"

	"github.com/spf13/cobra"
)

// waitPoll is how often wait reads the comments and the decisions.
var waitPoll = 10 * time.Second

// maxMine is how many of its own messages on a document the CLI remembers.
const maxMine = 500

type waitMessage struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
}

type waitThread struct {
	waitMessage
	Replies []waitMessage `json:"replies"`
}

type waitDecision struct {
	Decision  *string   `json:"decision"`
	DecidedAt time.Time `json:"decided_at"`
}

// feedback is what people gave on a document after a time: the open threads
// with a new message, and the decisions on its current content.
type feedback struct {
	threads, decisions []json.RawMessage
	// latest is the time of the newest message or decision in it.
	latest time.Time
}

func waitCmd(g *globals, out io.Writer) *cobra.Command {
	var settle, timeout time.Duration
	cmd := &cobra.Command{
		Use:   "wait <doc_id>",
		Short: "Wait for people to comment on or decide about a document",
		Long: `Wait for people to give feedback on a document, and print it.

wait returns the open threads that got a new message, when no new message
came for the --settle time. Thus a reviewer can finish a batch of comments
first. An approval or a rejection of the current content returns at once.

A message counts when it is newer than the feedback that the last wait gave,
and when this CLI did not write it. Thus a person who reviews in the browser
as the same user as the CLI gives feedback too. The first wait on a document
counts the messages after its start, so run it right after you publish. When
nothing comes before --timeout, wait prints "No new feedback.".`,
		Example: "  slashdocs docs wait doc_123\n  slashdocs docs wait doc_123 --settle 30s --timeout 5m",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			doc, start := args[0], time.Now()
			cl, err := client(g)
			if err != nil {
				return err
			}
			for {
				// The review is read again each time, as the agent can reply
				// while wait runs in the background.
				_, cx, _ := currentContext(g)
				review := Review{Since: start}
				if r := cx.Reviews[doc]; r != nil {
					review.Mine = r.Mine
					if !r.Since.IsZero() {
						review.Since = r.Since
					}
				}
				f, err := readFeedback(cl, doc, review)
				if err != nil {
					return err
				}
				now := time.Now()
				done := len(f.decisions) > 0 || (len(f.threads) > 0 && now.Sub(f.latest) >= settle)
				if done {
					if err := updateReview(g, doc, func(r *Review) { r.Since = f.latest }); err != nil {
						return err
					}
				}
				if done || now.Sub(start) >= timeout {
					return printFeedback(out, g, f, done)
				}
				time.Sleep(min(waitPoll, timeout-now.Sub(start)))
			}
		},
	}
	cmd.Flags().DurationVar(&settle, "settle", 2*time.Minute, "return when no new message came for this time")
	cmd.Flags().DurationVar(&timeout, "timeout", 9*time.Minute, "return with no feedback after this time")
	return cmd
}

func getJSON(cl *Client, path string, v any) error {
	b, err := cl.do("GET", path, nil, "")
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// readFeedback reads the feedback on a document that is newer than the
// review, in messages that the CLI did not write.
func readFeedback(cl *Client, docID string, review Review) (feedback, error) {
	var f feedback
	var comments, approvals struct{ Items []json.RawMessage }
	if err := getJSON(cl, apiPath("/v1/documents/%s/comments", docID)+"?status=open", &comments); err != nil {
		return f, err
	}
	if err := getJSON(cl, apiPath("/v1/documents/%s/approvals", docID), &approvals); err != nil {
		return f, err
	}
	newer := func(t time.Time) bool {
		if t.After(review.Since) {
			f.latest = maxTime(f.latest, t)
			return true
		}
		return false
	}
	for _, raw := range comments.Items {
		var t waitThread
		if err := json.Unmarshal(raw, &t); err != nil {
			return f, err
		}
		counted := false
		for _, m := range append(t.Replies, t.waitMessage) {
			if !slices.Contains(review.Mine, m.ID) && newer(m.CreatedAt) {
				counted = true
			}
		}
		if counted {
			f.threads = append(f.threads, raw)
		}
	}
	for _, raw := range approvals.Items {
		var d waitDecision
		if err := json.Unmarshal(raw, &d); err != nil {
			return f, err
		}
		if d.Decision != nil && newer(d.DecidedAt) {
			f.decisions = append(f.decisions, raw)
		}
	}
	return f, nil
}

func maxTime(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

// mine passes on the response of a message that the CLI wrote on a document,
// and keeps its id, so that wait does not give it as feedback.
func mine(g *globals, docID string) func([]byte, error) ([]byte, error) {
	return func(b []byte, err error) ([]byte, error) {
		var m waitMessage
		if err != nil || json.Unmarshal(b, &m) != nil || m.ID == "" {
			return b, err
		}
		return b, updateReview(g, docID, func(r *Review) {
			r.Mine = append(r.Mine, m.ID)
			r.Mine = r.Mine[max(0, len(r.Mine)-maxMine):]
		})
	}
}

// updateReview changes the review of a document in the current context.
func updateReview(g *globals, docID string, change func(*Review)) error {
	name, cx, cfg, err := currentContextE(g)
	if err != nil || name == "" {
		return err
	}
	if cx.Reviews == nil {
		cx.Reviews = map[string]*Review{}
	}
	if cx.Reviews[docID] == nil {
		cx.Reviews[docID] = &Review{}
	}
	change(cx.Reviews[docID])
	cfg.Contexts[name] = cx
	return saveConfig(cfg)
}

// printFeedback prints the threads and the decisions when wait is done, or
// else why nothing came.
func printFeedback(out io.Writer, g *globals, f feedback, done bool) error {
	if !done {
		f.threads, f.decisions = nil, nil
	}
	if g.json {
		return renderValue(out, g, map[string]any{
			"items":     append([]json.RawMessage{}, f.threads...),
			"decisions": append([]json.RawMessage{}, f.decisions...),
		})
	}
	switch {
	case done:
		return renderValue(out, g, map[string]any{"items": append(f.threads, f.decisions...)})
	case f.latest.IsZero():
		return message(out, g, "No new feedback.")
	}
	return message(out, g, "A review is in progress: run wait again.")
}

package repo

// Enabled is the personal preference at the requested scope. EffectiveEnabled
// also includes the global preference. Muting never changes document access.
type NotificationPreferences struct {
	Enabled          bool `json:"enabled"`
	EffectiveEnabled bool `json:"effective_enabled"`
}

type CommentNotification struct {
	CommentID   string
	RecipientID string
	Reason      string
	Attempts    int
	// FinishedProviders names the providers that need no further attempt.
	FinishedProviders []string
}

type DocumentAccessNotification struct {
	DocumentID   string
	RecipientID  string
	Source       string
	Reason       string
	PreviousRole Role
	Role         Role
	Attempts     int
	// FinishedProviders names the providers that need no further attempt.
	FinishedProviders []string
}

type DocumentAccessRequestNotification struct {
	DocumentID     string
	RequesterType  string
	RequesterID    string
	RequesterLabel string
	RecipientID    string
	Attempts       int
	// FinishedProviders names the providers that need no further attempt.
	FinishedProviders []string
}

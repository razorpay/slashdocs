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
}

type DocumentAccessNotification struct {
	DocumentID   string
	RecipientID  string
	Source       string
	Reason       string
	PreviousRole Role
	Role         Role
	Attempts     int
}

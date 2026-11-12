-- +goose Up
ALTER TABLE comment_reactions DROP CONSTRAINT comment_reactions_emoji_check;
ALTER TABLE comment_reactions ADD CONSTRAINT comment_reactions_emoji_check
  CHECK (emoji IN ('+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes', 'plus'));

-- +goose Down
-- Rows using the slug being removed must go first, or the narrower constraint
-- cannot be validated.
DELETE FROM comment_reactions WHERE emoji = 'plus';
ALTER TABLE comment_reactions DROP CONSTRAINT comment_reactions_emoji_check;
ALTER TABLE comment_reactions ADD CONSTRAINT comment_reactions_emoji_check
  CHECK (emoji IN ('+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'));

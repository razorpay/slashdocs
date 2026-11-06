// Wire format of a comment anchor, shared with the slashdocs API (repo.Anchor).
//
// The fields map onto two W3C Web Annotation selectors:
//   - quote/prefix/suffix        -> TextQuoteSelector
//   - start_offset/end_offset    -> TextPositionSelector (character offsets
//     into the document body's raw `textContent`)
//
// `dom_path` is legacy presentation metadata and is always "body".
export interface CommentAnchor {
  quote?: string;
  prefix?: string;
  suffix?: string;
  dom_path?: string;
  start_offset?: number;
  end_offset?: number;
}

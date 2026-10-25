- The terrain proxy stops asking the upstream for a while after a 429
  (its Retry-After, at most 10 minutes, or 60 s) instead of retrying on every
  page request (quanticsoul4772, #1402).

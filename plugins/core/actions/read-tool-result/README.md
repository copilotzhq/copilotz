# Read Tool Result Action

Reads a bounded byte range from a historical Tool result after checking that the
calling Agent owns the result in the current thread. Literal search uses plain
text and never interprets a pattern as a regular expression.

The Action is exposed through the built-in `readToolResult` Tool Resource.

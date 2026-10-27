# A broken diagram

Deliberately invalid so `trawl check examples` has something to report: the `;` inside the `Note` ends the statement
early, a classic Mermaid gotcha.

```mermaid
sequenceDiagram
  participant A as Orders API
  participant P as Payments
  A->>P: authorize(amount)
  Note over A: retries 3 times; then gives up
  P-->>A: authorized
```

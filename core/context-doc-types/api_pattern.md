---
type: api_pattern
target: api_pattern.md
tree_key: api_pattern
applies_when: "API-bearing projects (exposes or consumes an API — endpoints, RPC, or a typed client)"
consult_when: "designing or consuming an endpoint, shaping a request/response, or choosing an API convention"
maintain_when: "an endpoint convention, request/response shape, or API standard changes"
summary: "The project's API conventions — endpoint shape, request/response contracts, and integration patterns."
optional: true
kind_affinity: "API"
---

# api_pattern

The project's authoritative API conventions: how endpoints are shaped, how
requests and responses are structured, and the patterns for integrating with the
API. This is the doc `/promote` graduates an **API** standard (endpoint shape,
request/response convention) into.

## Section skeleton

> The structure `/ground` authors from. Fill each section from the project's
> actual API surface and client code.

## Endpoint conventions
How endpoints are named, versioned, and organized; the verbs and routing rules.

## Request/response shapes
The contract for request and response bodies — envelopes, error shapes, pagination,
field naming.

## Integration patterns
How the project consumes APIs (the typed client, retry/timeout policy, auth
handling) and how callers are expected to integrate.

## Conventions & decisions
API-level decisions the project stands by (a transport choice, a serialization
rule, a rejected shape) — each with its why.

---
aip: 5
title: Model Routing Peers
description: Defines the routing peer role, its discovery and reserved request paths, and the buyer-side router interface for cross-model routing.
author: Marco De Rossi (@marcoderossi90), Dawid (@Dawe000)
discussions-to: https://github.com/AntSeed/antseed/discussions
status: Draft
type: Standards Track
category: Core
created: 2026-08-27
requires: 3
---

## Abstract

This AIP adds a routing peer role to AntSeed: a peer that, given a buyer's
conversation and the network's live prices, returns a ranked list of
`(model, peer)` candidates instead of serving inference itself. Buyers who opt
in send a chat request whose model field is a sentinel rather than a concrete
model id; a routing-aware `Router` plugin recognizes the sentinel, asks a
routing peer to rank candidates, and dispatches through the network's existing
failover walk exactly as it would for a fixed model choice.

The proposal specifies three things: how a routing peer advertises itself and
is discovered, without adding a new capability enum or a metadata codec
version bump; the two reserved request paths a routing peer serves and their
dispatch and rate-limit rules, modeled directly on [AIP-3](./aip-3.md)'s
attestation route; and five new optional methods on the existing buyer-side
`Router` interface that let a plugin pick model and seller together, ahead of
AntSeed's existing fixed-model peer-selection pipeline, while that pipeline
stays completely unmodified for any buyer who does not opt in.

This AIP makes no contract change and no payment-message change. How a
routing peer charges for its service is left to a companion AIP; this one
treats routing peers as offering their service for free, exactly like
attestation.

## Motivation

AntSeed lets a buyer pick a model and then finds the best-priced, most
trustworthy seller of that exact model. It has no mechanism for a service
that recommends *which model* to use in the first place, weighing quality
against cost across the whole catalogue and across sellers. That
recommendation only has value if it can see the network's real, live prices —
which a buyer's own client already discovers — and if it can factor in
per-conversation state, such as which seller already holds a warm cache of
this conversation's prefix, that the recommending party cannot itself observe
without the buyer's help. A routing peer is a natural role for this: an
ordinary AntSeed seller node, paid like a seller, but one that returns a
ranked list rather than an inference result.

Two aspects of "just add a new capability" turn out not to work with what
exists on the network today, which shapes this proposal's discovery design:

- `ProviderCapability` and `PeerOffering`, the enum-and-topic mechanism that
  looks like the obvious place for a new "routing" value, is unwired end to
  end: no announcer call site ever populates `offerings`, and the
  corresponding DHT lookup has no caller anywhere in the buyer path. Adding a
  value there would not make a routing peer discoverable by anything that
  exists today.
- A peer that runs nothing but a routing handler and no inference `Provider`
  does not announce to the DHT at all under the current node implementation,
  because the announcer is only constructed when at least one provider is
  registered. A routing-only peer would be unreachable by construction unless
  this is fixed.

Separately, the reserved-path pattern this proposal needs — a seller-side
handler claiming its own URL prefix, served before provider matching and
before payment — already exists for attestation ([AIP-3](./aip-3.md)). That
AIP's capability-string advertisement, dispatch-and-rate-limit rules, and
plugin-registration shape transfer to routing almost unchanged; this proposal
follows that precedent deliberately rather than inventing a parallel one.

## Specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in RFC 2119.

### Routing Peer Role

A routing peer is an ordinary AntSeed seller node — the same `PaymentMux`,
signed metadata, and connection handling any seller runs — that registers a
routing handler and MAY register no inference `Provider` at all. A routing
peer MUST NOT be required to run a `Provider` to be reachable; see
Discovery below.

### Discovery

A routing peer advertises support with the peer capability string
`routing.v1` in `PeerMetadata.capabilities`, following the pattern
[AIP-3](./aip-3.md) established for `verifier.<id>`: capability strings are
appended to the existing v10+ capability list, so this requires no new
`ProviderCapability` enum value, no DHT capability topic, and no
`METADATA_VERSION` bump. `routing.v1` MUST conform to the existing capability
grammar (`^[a-z0-9][a-z0-9.-]*$`, max 64 characters) and count against the
existing per-peer capability limit (16). A future incompatible routing
protocol revision MAY advertise `routing.v2` alongside or instead of
`routing.v1`; a buyer that only understands `v1` MUST ignore capability
strings it does not recognize.

A peer's announcer MUST start, and MUST include `routing.v1` in its
advertised capabilities, whenever a routing handler is registered, regardless
of how many inference providers are also registered — including zero. A node
implementation that only announces when at least one provider is registered
MUST be corrected as part of implementing this AIP; a routing-only peer that
never reaches the DHT is not a conforming implementation.

A buyer discovers routing peers through its existing peer-discovery sweep
(unchanged by this AIP) and filters the resulting peer set by the `routing.v1`
capability string, the same way an [AIP-3](./aip-3.md) buyer filters for
`verifier.*` capabilities. No new DHT topic, lookup call, or discovery
round-trip is introduced.

### Reserved Request Paths

The path prefix `/_antseed/route` (`ANTSEED_ROUTE_PATH`) and the path
`/_antseed/route/digest` (`ANTSEED_ROUTE_DIGEST_PATH`) are reserved. A seller
MUST route a `POST` request for either path to its registered routing
handler, and MUST do so before provider matching. A routing handler MUST be
implemented as:

```typescript
interface RoutingServerHandler {
  handleRoute(buyerPeerId: string, req: SellerRequest): SellerResponse | Promise<SellerResponse>
}
```

`SellerRequest` is `{ method, path, headers?, body? }` and `SellerResponse` is
`{ statusCode, headers, body }`, the same shapes [AIP-3](./aip-3.md) defines
for `Prover`. A node MUST expose a single-slot registration for a routing
handler (one routing identity per seller, unlike the name-keyed list of
provers a seller MAY run), mirroring the buyer-side single `Router` slot this
AIP also extends.

Dispatch rules:

- Exactly one routing handler MAY be registered per node. A `POST` to either
  reserved path when no handler is registered MUST return `404` with error
  code `not_routing_peer`.
- Otherwise the seller MUST call `handleRoute(buyerPeerId, req)` and return
  its `SellerResponse` unmodified. A handler that throws or rejects MUST come
  back as a `500` response of type `routing_error` and MUST NOT crash request
  handling.
- Both paths dispatch to the same handler. A handler distinguishes a route
  request from a digest submission by `req.path`, since the request bodies
  defined below are structurally distinct (a route request always carries
  `inputMessage`; a digest submission never does). An implementation MAY also
  reject a request on the wrong path with `400` rather than relying on body
  shape.
- A routing peer that gates on payment (left to a companion AIP; see Payments
  below) MUST reject before calling into any ranking logic, with `402`, so an
  unpaid caller never triggers the expensive part of the handler.

### Routing Request Rate Limit

Ranking a request is expensive — it MAY call out to a separate scoring
process — so, exactly as [AIP-3](./aip-3.md) requires for the attestation
path, a seller MUST rate-limit `/_antseed/route` per buyer peer, with the
tracking table capped so the limiter itself cannot become a memory-exhaustion
vector. Cheap `400`/`402`/`404` rejections MUST NOT count against a buyer's
quota; only a call that reaches `handleRoute` does. `/_antseed/route/digest`,
being a small, fixed-shape, once-daily submission, is not subject to this
rate limit but MUST still be size-bounded by the seller's ordinary request-size
limits.

### Wire Schemas

The `POST /_antseed/route` request body:

```typescript
interface RouteRequestBody {
  v: 1; // wire schema version
  cqt: number; // cost/quality tradeoff, 0-10, buyer-chosen
  inputMessage: string; // routing peer's own ranking-input format; opaque to this AIP
  promptTokens: number; // buyer's own token estimate for inputMessage
  expectedCachedTokens: Array<{
    model: string; // candidate model this cache-hit estimate applies to
    peer: string; // candidate peer this cache-hit estimate applies to
    tokens: number; // tokens of this conversation's prefix the buyer has observed that peer/model already holding warm
  }>;
  constraints: {
    maxInputUsdPerMillion?: number; // buyer's price ceiling; advisory pre-filter, not authoritative
    minTrustScore?: number; // buyer's trust floor, 0-100 scale; advisory pre-filter, not authoritative
    allowedPeerIds?: string[]; // buyer's explicit allow-list; advisory pre-filter, not authoritative
    blockedPeerIds?: string[]; // buyer's explicit block-list; advisory pre-filter, not authoritative
  };
}
```

`cqt` is a cost/quality tradeoff value on a 0–10 scale, buyer-chosen.
`inputMessage` MUST be the routing peer's own input format for whatever
ranking scheme it runs; this AIP does not standardize prompt content, only
that a string field carries it. `expectedCachedTokens` lets the buyer report,
per candidate it has itself observed billing for, how many tokens of this
conversation's prefix that seller already holds warm — a routing peer MUST
NOT be expected to track this itself, since a routing peer that retains no
per-conversation history cannot observe it. `constraints` carries the buyer's
own policy: a routing peer SHOULD use these fields to pre-filter its ranking,
but a buyer MUST NOT rely on a routing peer's filtering as authoritative — see
Rationale.

The `POST /_antseed/route` response body, on success:

```typescript
interface RouteResponseBody {
  v: 1; // wire schema version
  ranked: Array<{
    model: string; // candidate's model id
    peer: string; // candidate's peer id
    estimate: {
      costUsd: number; // routing peer's predicted total cost for this candidate
      inputTokens: number; // routing peer's predicted fresh input tokens
      cachedInputTokens: number; // routing peer's predicted cached input tokens
      outputTokens: number; // routing peer's predicted output tokens
    };
    price: {
      inUsdPerM: number; // candidate's fresh input price, USD per million tokens
      outUsdPerM: number; // candidate's output price, USD per million tokens
      cachedInUsdPerM: number; // candidate's cached input price, USD per million tokens
    };
  }>;
  router: string; // routing-peer-chosen identifier for which router/version produced this response; diagnostics only, not parseable
}
```

`ranked` MUST be ordered by the routing peer's own objective, best candidate
first. A buyer MUST treat this order as the routing decision itself and MUST
NOT locally re-sort it by an independent signal such as reputation before
walking it, since doing so would discard the quality/cost tradeoff the
ranking encodes; a buyer's own policy filtering (allow/block lists, price and
trust ceilings) applies during the walk, skipping disallowed entries in
place, not by re-ordering the remainder. `price` MUST be populated for every
ranked entry, not only the winner, so a buyer can compute a savings figure
against any candidate without a separate price lookup and without the
routing peer needing to remember which candidates it offered to which buyer.
`estimate` carries the routing peer's own per-candidate prediction, in the
same units a buyer already reconciles against observed usage elsewhere in
this protocol; it MUST be populated for every ranked entry, same as `price`.
Whatever internal signal the routing peer used to produce the ranking itself
(a numeric score, a raw quality prediction, or anything else its own ranking
scheme computes) is that routing peer's own implementation detail and is NOT
part of this wire response — a buyer has no use for a number it cannot
recompute or independently verify, only for the order it produces and the
concrete price/estimate figures it can check usage against. `router` is a
single, routing-peer-chosen string identifying which router/version served
this response, for a buyer's own logging or support diagnostics; this AIP
does not standardize its format beyond being a plain string, and a buyer
MUST NOT parse it for routing decisions.

The `POST /_antseed/route/digest` request body:

```typescript
interface DailyDigestBody {
  v: 1; // wire schema version
  period: string; // calendar day, YYYY-MM-DD, buyer's own local time zone
  routedRequests: number; // count of requests routed this period
  predictedCostUsd: number; // sum of estimate.costUsd across this period's routed requests
  observedCostUsd: number; // sum of what the buyer actually paid this period
  predictedInputTokens: number; // sum of predicted fresh input tokens this period
  predictedCachedInputTokens: number; // sum of predicted cached input tokens this period
  predictedOutputTokens: number; // sum of predicted output tokens this period
  observedInputTokens: number; // sum of actual fresh input tokens this period
  observedCachedInputTokens: number; // sum of actual cached input tokens this period
  observedOutputTokens: number; // sum of actual output tokens this period
  modelMix: Record<string, number>; // request count per model actually used this period
  failovers: number; // count of requests that failed over to a later-ranked candidate
  timeouts: number; // count of requests that timed out waiting on a routing decision
  avgRoutingLatencyMs: number | null; // mean wall-clock time to produce a routing decision this period; null if none were timed
  cqtDistribution: Record<number, number>; // request count per cqt value used this period
}
```

`period` MUST be a calendar day in `YYYY-MM-DD` form, in the buyer's own
local time zone. This is a fixed, closed schema: it MUST carry only
period-level aggregate counters and MUST NOT carry prompt content,
per-request rows, or any field that ties a routing decision to the message
that produced it. A digest submission has no response body requirement
beyond an HTTP status; a routing peer SHOULD return `204`.

### Interface: `Router` Extensions

The existing buyer-side `Router` interface gains five new, all-optional
methods. A `Router` that implements none of them is fully conforming and
unaffected by this AIP; existing behavior for `selectPeer` and `onResult` is
unchanged.

```typescript
interface Router {
  // Existing, unchanged:
  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null; // fixed-model peer selection, predates this AIP
  onResult(peer: PeerInfo, result: {
    success: boolean;
    latencyMs: number;
    tokens: number;
    // New, optional, additive fields on the existing result object:
    freshInputTokens?: number; // observed fresh (non-cached) input tokens for this request
    cachedInputTokens?: number; // observed cached input tokens for this request
    outputTokens?: number; // observed output tokens for this request
    estimatedCostUsd?: number | null; // observed cost for this request, same computation buyer-proxy already derives at both onResult call sites
    requestId?: string; // the originating client request's id, stable across a peer walk for one client request; lets a router pair this result with the selectRoute decision that produced it
  }): void;

  // New, all optional:
  selectRoute?(
    req: SerializedHttpRequest, // raw, unmodified request -- a plugin reads its own sentinel from req.body itself
    peers: PeerInfo[], // the buyer's currently discovered peer set
    conversation: ConversationIdentity | null, // identity of the chat this request belongs to, null when it can't be determined
    routingPreferences: ModelRoutingPreferences | null, // the buyer's current routing preferences
    defaultRoutedModel?: string | null, // the pre-existing "antseed" alias's currently-resolved target, host-owned state
  ): Promise<RouteCandidate[] | null>; // null is a decline, falling through to the unmodified fixed-model pipeline

  getRoutingDecisions?(): RoutingDecisionRow[]; // the router's own local routing_decisions ledger, if it keeps one, for a host's savings-dashboard UI
  configureDailySigning?(signDailyIfNeeded: (sellerPeerId: string) => Promise<void>): void; // hands the router a host-provided signing closure it can call to trigger its own daily payment; the router never touches the buyer's actual signer directly
  triggerDailySigningCheck?(): Promise<void>; // lets a host-owned background timer poke the same daily-signing gate outside of any request in flight, so a subscription doesn't lapse on a day with no chat traffic
  updateRoutingPreferences?(preferences: ModelRoutingPreferences): void; // pushed by the host whenever live preferences change, including once at startup, so an already-running router picks up changes without a request in flight
}

type RouteCandidate = {
  peer: PeerInfo; // the candidate seller's full discovered peer record
  peerId: string; // the candidate seller's peer id
  serviceId: string; // the model this candidate serves
  request: SerializedHttpRequest; // already model-substituted for this candidate
  reputation: number; // the candidate's reputation, 0-100 scale
  hasCachedInputPricing: boolean; // whether the candidate advertises a cached-input price for this service
  inputUsdPerMillion: number | null; // the candidate's advertised fresh input price, null if unadvertised
  outputUsdPerMillion: number | null; // the candidate's advertised output price, null if unadvertised
  minImageUsdPerImage: number | null; // the candidate's advertised image-generation price, null for a non-image service
};

type RoutingDecisionRow = {
  atMs: number; // wall-clock time this decision was made
  actualModel: string; // the model actually used
  actualPeer: string; // the peer actually used
  actualPromptTokens: number; // observed prompt tokens, fresh and cached combined
  actualCachedTokens: number; // observed cached-subset of actualPromptTokens
  actualCompletionTokens: number; // observed output tokens
  actualUsdcPaid: number; // what actually settled for this request; not a billing record itself, real settlement is governed by the signed SpendingAuth
  predictedCostUsd: number | null; // this decision's own predicted cost, captured at selectRoute time; null when the gate skipped the call entirely
  predictedInputTokens: number | null; // predicted fresh input tokens; null when the gate skipped the call entirely
  predictedCachedInputTokens: number | null; // predicted cached input tokens; null when the gate skipped the call entirely
  predictedOutputTokens: number | null; // predicted output tokens; null when the gate skipped the call entirely
  cqt: number; // the cost/quality dial value in effect for this decision
  routingLatencyMs: number | null; // wall-clock time the routing call itself took; null when the gate skipped the call entirely (e.g. a reused decision)
  // Price snapshot for each fixed, curated baseline model that was actually
  // present in this decision's ranked response, collapsed across peers to
  // the best available offer per model, keyed by model name -- absent
  // entirely for a baseline model not offered at the moment of this
  // decision. Lets a savings dashboard compare actual paid against one
  // fixed reference model's real price at the time of THIS decision, without
  // holding a live price table or re-fetching anything.
  baselinePrices: Record<string, { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number | null }>;
};

type ConversationIdentity = {
  tool: string; // slug for the originating tool (e.g. 'claude-code', 'codex', 'opencode', 'unknown')
  sessionKey: string; // stable per-conversation key as sent by the tool
  parentSessionKey: string | null; // parent session for subagent traffic, when the tool advertises one
  isUserThread: boolean; // false when the tool declares this thread its own housekeeping rather than a user's chat; true by default
};

type ModelRoutingPreferences = {
  preferFreePeers: boolean; // prefer $0-priced candidates when ranking
  maxInputUsdPerMillion: number; // buyer's price ceiling
  minTrustScore: number; // buyer's trust floor, 0-100 scale
  allowedPeerIds: string[]; // buyer's explicit allow-list
  blockedPeerIds: string[]; // buyer's explicit block-list
  cqt?: number; // cost/quality tradeoff dial, one of the five discrete values {1,3,5,7,9}; only meaningful to a router that implements selectRoute
  autoSubscriptionEnabled?: boolean; // explicit opt-in to a subscription-priced router's daily signing; off by default, a router gating real signing on this MUST treat "unknown" the same as false, never as implicit consent
};
```

`ModelRoutingPreferences` is buyer routing preference data, not `Router`
configuration — a routing peer's own setup (its URL, credentials, seller
identity) lives in whatever plugin-configuration mechanism the host already
uses for its other plugins, not in this type or on the wire. A `Router`
implementation MUST be fully configurable through its own plugin
configuration alone; it MUST NOT require `ModelRoutingPreferences` to carry
anything beyond the buyer-facing preference fields already listed above.

A host (buyer proxy) implementation MUST call `selectRoute` before its
existing fixed-model peer-narrowing step, whenever the registered `Router`
implements it, and MUST treat a `null` result — including a `Router` that
does not implement `selectRoute` at all — as a decline, falling through to
the unmodified existing pipeline with no other change in behavior. A host
MUST pass the request exactly as received, before any host-level model-alias
substitution the buyer applies for its own purposes; a plugin recognizes its
own sentinel model value from `req.body` itself. A host MUST NOT hardcode,
special-case, or validate against any specific sentinel string — that
recognition is entirely the plugin's business, so that different `Router`
implementations MAY choose different sentinels without any host change.

When `selectRoute` returns a non-null list, the host MUST walk it in the
returned order using its existing per-candidate failover mechanism (fail over
before the first token of a response, terminal after), MUST NOT re-sort it
locally, and MUST call `onResult` for the peer actually used exactly as it
does for a fixed-model selection. A host MUST forward `routingPreferences` to
`selectRoute` on every call and MUST push preference updates to a `Router`
that implements `updateRoutingPreferences` whenever those preferences change,
including once at startup.

A `Router` MUST NOT be given direct access to the buyer's payment-signing
key. A `Router` that needs to trigger its own periodic signing (for example,
a subscription-priced routing peer under a companion pricing AIP) MUST do so
only through a host-provided signing closure passed via
`configureDailySigning`, never by holding a reference to the buyer's signer
or payment manager directly.

### Payments

This AIP specifies no contract change and no payment-message change. It does
not add, remove, or modify any `MessageType` value, any EIP-712 struct, or
any Solidity contract. A routing peer served under this AIP is unpriced,
exactly like attestation under [AIP-3](./aip-3.md); the `402` gate described
under Reserved Request Paths is a hook this AIP reserves for a companion AIP
to fill in, not something this AIP itself defines the mechanism for. How a
routing peer charges — flat-rate subscription pricing, per-request metering,
or something else — is left entirely to that companion proposal.

## Rationale

**Modeled on AIP-3's attestation design, not a new pattern.**
[AIP-3](./aip-3.md) already solved this exact shape of problem: a seller-side
handler on a reserved path, served before provider matching and payment,
rate-limited per buyer, advertised as a capability string. This AIP reuses
that shape rather than inventing a parallel one. Two specific choices follow
from it: `routing.v1` is a capability *string*, not a new `ProviderCapability`
enum value, because the DHT machinery that enum would need is unwired end to
end and the capability-string path already works in production; and a routing
peer's announcer MUST start even with zero registered providers, since a
peer whose entire purpose is ranking rather than serving is the normal case
for this role, not a corner case to work around.

**The routing peer's ranked order is the decision, not a suggestion.** The
order encodes a quality/cost tradeoff a buyer can't independently recompute
from price and reputation alone, so a buyer MUST NOT locally re-sort it —
that would discard the tradeoff the ranking exists to provide. But the
routing peer's own `constraints` filtering is advisory only: a buyer MUST
still re-apply its own price/trust/allow-block policy locally before
dispatch, since a candidate can go stale (peer drops offline, cools down)
between the routing call and dispatch. Policy filters the given order in
place; it never re-ranks it.

**Sentinel strings stay inside the plugin.** A host that recognized one
router's sentinel model string by name would privilege that implementation
over any other `Router` a buyer might load. The host forwards the request
unmodified; only the plugin knows what its own sentinel means.

**Pricing and the digest are both deliberately out of scope here.** This AIP
treats a routing peer as free, the same bootstrapping path attestation took —
bundling a pricing scheme into this proposal would force reviewers to accept
or reject both together. The daily digest reuses this AIP's own reserved-path
infrastructure rather than the protocol's payment-message enum, since it's
optional, non-billing statistics, not something that needs a new
protocol-wide surface.

## Backwards Compatibility

This proposal is additive. A peer that advertises no `routing.v1` capability
is unaffected by this AIP; a `Router` implementation that does not implement
any of the five new optional methods is unaffected and behaves exactly as it
does today. The `/_antseed/route` and `/_antseed/route/digest` paths are
newly reserved, so a seller MUST NOT route either to a provider — though
neither was ever a valid model or service id, so no existing conforming
seller can already be using them for anything else. No metadata codec
version bump, no `METADATA_VERSION` change, and no payment-message change is
required. Mixed-version networks interoperate: a routing-aware buyer skips
peers that advertise no `routing.v1` capability, and a routing-advertising
peer is ignored by buyers that do not implement `selectRoute` at all, exactly
as [AIP-3](./aip-3.md) describes for verifier capabilities.

## Security Considerations

**Unmetered ranking is a denial-of-service surface.** Ranking MAY be
expensive (a separate scoring process). This AIP defines no payment gate, so
until a companion pricing AIP exists, per-buyer rate limiting on
`/_antseed/route` is the only cost control a routing peer has — an
implementation MUST NOT skip it on the theory that payment will handle abuse
later.

**Prompt content leaves the buyer's device.** `inputMessage` gives the
routing peer itself access to conversation content on every routed request —
in addition to, not instead of, whichever inference seller ultimately
answers it. Routing a request means two parties see the prompt instead of
one. A buyer SHOULD trust a routing peer the way it trusts any seller it
sends prompts to, and SHOULD be able to see which peer identity it's routing
through.

**A dishonest routing peer can steer, but not override, a buyer's policy.**
Because the returned order is treated as the decision, a compromised routing
peer could bias its ranking toward affiliated sellers. This is bounded, not
eliminated: a `Router` implementation MUST re-apply the buyer's own
`constraints` locally before dispatch rather than trusting the routing peer's
own filtering (which is advisory, not authoritative — see Rationale), so a
routing peer can bias an ordering but cannot force a buyer to pay outside its
own price, trust, or allow/block bounds.

**Daily digests are aggregate, but a stable buyer id still makes them
linkable over time.** A sequence of `modelMix` values keyed to a real peer id
is a coarse usage profile. A routing peer operator SHOULD key stored digests
by a one-way function of the buyer's peer id rather than the raw id; this AIP
leaves the specific scheme to the operator.

**Plugins never hold a buyer's signing key.** `configureDailySigning`'s
closure-based design means a `Router` — including a third-party one — never
receives the buyer's actual private key or a handle that can sign arbitrary
messages. A host implementation MUST NOT expose its payment manager or
signer directly to plugin code under any of this AIP's new methods.

## Copyright

Copyright and related rights waived via [CC0](../LICENSE).

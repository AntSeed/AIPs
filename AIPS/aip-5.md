---
aip: 5
title: Model Routing Peers
description: Defines the routing peer role, its discovery and reserved request paths, and the buyer-side router interface for cross-model routing.
author: Marco De Rossi (@marcoderossi90)
discussions-to: https://github.com/AntSeed/antseed/discussions
status: Draft
type: Standards Track
category: Core
created: 2026-08-27
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
  `sagePrompt`; a digest submission never does). An implementation MAY also
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
  v: 1;
  cqt: number;
  inputMessage: string;
  promptTokens: number;
  expectedCachedTokens: Array<{ model: string; peer: string; tokens: number }>;
  constraints: {
    maxInputUsdPerMillion?: number;
    minTrustScore?: number;
    allowedPeerIds?: string[];
    blockedPeerIds?: string[];
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
  v: 1;
  ranked: Array<{
    model: string;
    peer: string;
    estimate: { costUsd: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
    price: { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number };
  }>;
  router: string;
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
  v: 1;
  period: string;
  routedRequests: number;
  predictedCostUsd: number;
  observedCostUsd: number;
  predictedInputTokens: number;
  predictedCachedInputTokens: number;
  predictedOutputTokens: number;
  observedInputTokens: number;
  observedCachedInputTokens: number;
  observedOutputTokens: number;
  modelMix: Record<string, number>;
  failovers: number;
  timeouts: number;
  avgRoutingLatencyMs: number | null;
  cqtDistribution: Record<number, number>;
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
  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null;
  onResult(peer: PeerInfo, result: {
    success: boolean;
    latencyMs: number;
    tokens: number;
    // New, optional, additive fields on the existing result object:
    freshInputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number | null;
    requestId?: string;
  }): void;

  // New, all optional:
  selectRoute?(
    req: SerializedHttpRequest,
    peers: PeerInfo[],
    conversation: ConversationIdentity | null,
    routingPreferences: ModelRoutingPreferences | null,
    defaultRoutedModel?: string | null,
  ): Promise<RouteCandidate[] | null>;

  getRoutingDecisions?(): RoutingDecisionRow[];
  configureDailySigning?(signDailyIfNeeded: (sellerPeerId: string) => Promise<void>): void;
  triggerDailySigningCheck?(): Promise<void>;
  updateRoutingPreferences?(preferences: ModelRoutingPreferences): void;
}

type RouteCandidate = {
  peer: PeerInfo;
  peerId: string;
  serviceId: string;
  request: SerializedHttpRequest;
  reputation: number;
  hasCachedInputPricing: boolean;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  minImageUsdPerImage: number | null;
};

type RoutingDecisionRow = {
  atMs: number;
  actualModel: string;
  actualPeer: string;
  actualPromptTokens: number;
  actualCachedTokens: number;
  actualCompletionTokens: number;
  actualUsdcPaid: number;
  predictedCostUsd: number | null;
  predictedInputTokens: number | null;
  predictedCachedInputTokens: number | null;
  predictedOutputTokens: number | null;
  cqt: number;
  routingLatencyMs: number | null;
  baselinePrices: Record<string, { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number | null }>;
};

type ConversationIdentity = {
  tool: string;
  sessionKey: string;
  parentSessionKey: string | null;
  isUserThread: boolean;
};

type ModelRoutingPreferences = {
  preferFreePeers: boolean;
  maxInputUsdPerMillion: number;
  minTrustScore: number;
  allowedPeerIds: string[];
  blockedPeerIds: string[];
  cqt?: number;
  autoSubscriptionEnabled?: boolean;
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

**Capability string, not a new capability enum value.** The obvious design —
add `'routing'` to `ProviderCapability` — does not work with what the network
actually runs: the DHT capability-topic machinery that enum feeds is unwired
end to end. `routing.v1` as a peer capability string, by contrast, rides
exactly the same encode/decode/validate path `verifier.*`
([AIP-3](./aip-3.md)) already exercises in production, so it costs no new
metadata version and inherits a mechanism already proven to work.

**Fixing announcer gating rather than working around it.** A routing peer
that never runs an inference `Provider` is not a corner case — it is the
expected shape of a peer whose entire purpose is ranking, not serving. Making
peer announcement conditional on `Provider` registration would make routing
peers structurally undiscoverable; the fix belongs in the node's
announcement logic, not in a workaround at the routing layer.

**Modeled on attestation deliberately.** [AIP-3](./aip-3.md) already solved
the exact shape of problem this AIP has: a seller-side handler that claims a
reserved path, serves it before provider matching and payment, needs a
per-buyer rate limit because the work is expensive, and is advertised as a
capability string a buyer filters for during ordinary discovery. Rather than
re-deriving that design, this AIP reuses it, changing only what is
substantively different (ranking model-and-seller pairs, not proving a
claim) and leaving the plumbing shape the same.

**Preserving the routing peer's returned order.** A ranked list encodes a
quality/cost tradeoff the buyer's own client cannot independently recompute
from a peer's reputation and price alone — reputation is one input among
several the routing peer already folds in. Re-sorting the list locally by
reputation, the way AntSeed's existing fixed-model pipeline does when
choosing among sellers of one already-decided model, would discard that
tradeoff. The buyer's own policy filtering still applies, but as a filter
over the given order, not a re-ranking of it.

**The routing peer's constraints filtering is advisory, not authoritative.**
A buyer sends its own price/trust ceilings and allow/block lists so a
routing peer can pre-filter to what that buyer can actually use, but a buyer
MUST still re-apply its own policy locally before dispatching, because
constraints are a snapshot at request time: a peer can go unreachable, enter
a cooldown, or drop out of an allow list update between the routing call and
dispatch. Treating the routing peer's filtering as a courtesy rather than a
guarantee is what lets a stale constraint degrade a choice instead of
breaking it.

**Sentinel model strings are not part of this protocol.** A host that
special-cased one router's sentinel string would privilege that
implementation over any other `Router` a buyer might load. Keeping sentinel
recognition entirely inside the plugin, with the host forwarding the
unmodified request body, is what keeps the router-plugin slot genuinely
pluggable rather than nominally so.

**No payment mechanism in this AIP.** Coupling a new peer role to a specific
pricing scheme in the same proposal would force reviewers to accept or reject
both together. A routing peer is useful, and reviewable, as an unpriced
service first — the same bootstrapping path attestation took. A companion
AIP can specify metered, subscription, or other pricing for a routing peer
without reopening anything specified here.

**Digest as a separate submission, not bundled into a payment message.** A
routing peer's own reserved-path infrastructure already exists once this AIP
ships; reusing it for a small, periodic aggregate submission needs no new
protocol surface. Extending a closed, protocol-wide payment-message enum for
what is explicitly optional, non-billing statistics would be a heavier change
for a smaller benefit.

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

## Reference Implementation

Reference implementation branch:
https://github.com/levantolabs/antseed-levanto-router/tree/model-routing

Key surfaces:

- `RoutingServerHandler`, `ANTSEED_ROUTE_PATH`, `ANTSEED_ROUTE_DIGEST_PATH` in
  `packages/node/src/interfaces/plugin.ts`;
- reserved-path dispatch in `packages/node/src/seller-request-handler.ts`;
- the extended `Router` interface, `RouteCandidate`, and `RoutingDecisionRow`
  in `packages/node/src/interfaces/buyer-router.ts`;
- `ConversationIdentity` in `packages/node/src/routing/conversation-identity.ts`;
- `ModelRoutingPreferences` in `packages/node/src/routing/model-route-ranking.ts`;
- the `selectRoute` call site, candidate walk, and extended `onResult`
  telemetry in `apps/cli/src/proxy/buyer-proxy.ts`;
- the vendor `Router` implementation and wire-schema types in
  `plugins/router-levanto/src/router.ts` and `digest.ts`.

The reference branch's `routing.v1` capability advertisement and the
announcer fix for provider-less peers are not yet implemented as of this
AIP's Draft status; the branch currently advertises a routing peer's price
only, via a mechanism a companion pricing AIP covers, and its node
implementation still gates announcement on at least one registered provider.
Both are tracked as follow-up work against the reference implementation.

## Security Considerations

**Unmetered ranking is a denial-of-service surface.** Ranking a request MAY
be expensive, calling out to a separate scoring process. Exactly as with
attestation, a seller MUST rate-limit `/_antseed/route` per buyer peer with
bounded tracking state, so an unpaid or spam caller cannot exhaust a routing
peer's resources for free. This AIP defines no payment gate itself, so until
a companion pricing AIP is adopted, the rate limit is the only cost control a
routing peer has, and implementations MUST NOT skip it on the theory that
payment will handle abuse later.

**Prompt content leaves the buyer's device.** `sagePrompt` carries
conversation content to a third party the buyer has chosen to trust for
routing decisions, which is a strictly larger disclosure than ordinary
inference — an inference seller sees the prompt it actually answers; a
routing peer sees a representation of the prompt for every conversation a
buyer routes, whether or not that peer ends up serving it. A buyer SHOULD
apply the same trust judgment to a routing peer it applies to any seller it
sends prompts to, and an implementation SHOULD give a buyer visibility into
which peer identity it is routing through.

**A routing peer can steer buyers toward sellers it favors.** Because the
routing peer's returned order is treated as the decision (see Rationale), a
dishonest or compromised routing peer could bias its ranking toward
affiliated sellers rather than the buyer's actual best interest. This is
bounded, not eliminated, by two things this AIP requires: the buyer's own
`constraints` are still enforced locally regardless of what the routing peer
returns, and a buyer client retains final policy authority to reject or
reorder around any given candidate before dispatch — a routing peer can bias
an ordering, but it cannot force a buyer to pay for something outside that
buyer's own price, trust, or allow/block-list bounds.

**Unfiltered constraints could otherwise let an untrusted candidate through.**
Because a routing peer's own filtering is advisory (Rationale), an
implementation that skips local re-filtering after `selectRoute` returns
would let a stale or manipulated ranked list bypass the buyer's actual
policy. A conforming `Router` implementation MUST re-apply the buyer's
`constraints` locally before dispatch, not merely forward whatever the
routing peer returned.

**The daily digest is aggregate but still linkable across time.** Even
without prompt content, a per-subscriber sequence of daily aggregates —
`modelMix` in particular — can function as a coarse usage profile of one
buyer over time if stored under a stable, real buyer identifier. A routing
peer operator SHOULD key stored digests by a one-way function of the buyer's
peer id rather than the raw id, so that day-to-day linkage for calibration
purposes does not also reveal which real network peer a subscriber is
outside the routing peer's own records. This AIP does not mandate a specific
scheme, since digest retention and anonymization policy are the routing
peer operator's responsibility, not a wire-protocol requirement.

**Plugins never hold a buyer's signing key.** `configureDailySigning`'s
closure-based design exists specifically so that a `Router` — including a
third-party one, since this protocol is intentionally open to competing
implementations — never receives the buyer's actual private key or a
handle capable of signing arbitrary messages. A conforming host
implementation MUST NOT expose its payment manager or signer directly to
plugin code under any of this AIP's new interface methods.

## Copyright

Copyright and related rights waived via [CC0](../LICENSE).

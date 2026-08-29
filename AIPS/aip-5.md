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
version bump; the reserved request path a routing peer serves and its
dispatch rules, modeled directly on [AIP-3](./aip-3.md)'s attestation route;
and two new optional methods on the existing buyer-side
`Router` interface that let a plugin pick model and seller together, ahead of
AntSeed's existing fixed-model peer-selection pipeline, while that pipeline
stays completely unmodified for any buyer who does not opt in.

This AIP makes no smart contract change and no payment-message change. How a
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
AIP's capability-string advertisement, dispatch rules, and plugin-registration
shape transfer to routing almost unchanged; this proposal
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

The path `/_antseed/route` (`ANTSEED_ROUTE_PATH`) is reserved. A seller MUST
route a `POST` request for this path to its registered routing handler, and
MUST do so before provider matching. A routing handler MUST be implemented
as:

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

- Exactly one routing handler MAY be registered per node. A `POST` to the
  reserved path when no handler is registered MUST return `404` with error
  code `not_routing_peer`.
- Otherwise the seller MUST call `handleRoute(buyerPeerId, req)` and return
  its `SellerResponse` unmodified. A handler that throws or rejects MUST come
  back as a `500` response of type `routing_error` and MUST NOT crash request
  handling.
- A routing peer that gates on payment (left to a companion AIP; see Payments
  below) MUST reject before calling into any ranking logic, with `402`, so an
  unpaid caller never triggers the expensive part of the handler.

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
first. A host SHOULD treat this order as its routing decision and SHOULD
NOT locally re-sort it by an independent signal such as reputation before
walking it, since doing so would discard the quality/cost tradeoff the
ranking encodes — but this is a suggestion, not a binding instruction: a
buyer retains full discretion to disregard it, consult a different routing
peer it trusts more, or impose its own ranking on top of the returned order.
The `Router` implementation returning this list to the host
(inside `selectRoute`) is responsible for re-applying the buyer's own policy
(allow/block lists, price and trust ceilings) before returning it, dropping
disallowed entries rather than reordering around them — by the time the host
receives and walks the list, it MUST already reflect that policy. `price`
MUST be populated for every
ranked entry, not only the winner, so a buyer can compute a savings figure
against any candidate without a separate price lookup and without the
routing peer needing to remember which candidates it offered to which buyer.
`estimate` carries the routing peer's own per-candidate prediction, in the
same units a buyer already reconciles against observed usage elsewhere in
this protocol; it MUST be populated for every ranked entry, same as `price`.
`router` is a single, routing-peer-chosen string identifying which
router/version served this response, for a buyer's own logging or support
diagnostics; this AIP does not standardize its format beyond being a plain
string, and a buyer MUST NOT parse it for routing decisions.

### Interface: `Router` Extensions

The existing buyer-side `Router` interface gains two new, all-optional
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
  baselinePrices: Record<string, { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number | null }>; // best available price per fixed, curated baseline model actually offered in this decision's ranked response, keyed by model name, absent when a baseline model wasn't offered; lets a savings dashboard compare against a fixed reference without a live price table
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
};
```

`ModelRoutingPreferences` is buyer routing preference data, not `Router`
configuration — a routing peer's own setup (its URL, credentials, seller
identity) lives in whatever plugin-configuration mechanism the host already
uses for its other plugins, not in this type or on the wire. A `Router`
implementation MUST be fully configurable through its own plugin
configuration alone; it MUST NOT require `ModelRoutingPreferences` to carry
anything beyond the buyer-facing preference fields already listed above. This
excludes payment-model-specific consent, too: whether a buyer has opted into
a subscription-priced router's daily signing is not a preference every
router shares a use for (a metered or free router has nothing to check it
against), so it is not part of this type either — a subscription-priced
`Router` implementation reads that consent from its own plugin
configuration, the same place its other setup lives, never treating an
absent or unreadable value as consent.

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

A host that acts on a non-null `selectRoute` result SHOULD walk it in the
returned order using its existing per-candidate failover mechanism (fail over
before the first token of a response, terminal after) and SHOULD NOT re-sort
it locally, for the same reason given in Rationale — a host MAY instead
disregard the result, consult a different routing peer, or impose its own
ranking. Whichever path a host takes, it MUST call `onResult` for the peer
actually used exactly as it does for a fixed-model selection, and MUST
forward the buyer's current `routingPreferences` to `selectRoute` on every
call.

A `Router` MUST NOT be given direct access to the buyer's payment-signing
key or payment manager. This AIP defines no signing mechanism of its own; a
`Router` that needs to trigger its own periodic signing (for example, a
subscription-priced routing peer) gets that capability from whatever
companion pricing AIP defines it, and that mechanism MUST itself be a
host-provided closure the router calls, never a direct reference to the
buyer's signer.

### Payments

This AIP specifies no smart contract change and no payment-message change. It does
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
advertised as a capability string. This AIP reuses that shape rather than
inventing a parallel one. Two specific choices follow
from it: `routing.v1` is a capability *string*, not a new `ProviderCapability`
enum value, because the DHT machinery that enum would need is unwired end to
end and the capability-string path already works in production; and a routing
peer's announcer MUST start even with zero registered providers, since a
peer whose entire purpose is ranking rather than serving is the normal case
for this role, not a corner case to work around.

**The routing peer's ranked order is a suggestion, not a binding decision.**
The order encodes a quality/cost tradeoff a buyer can't independently
recompute from price and reputation alone, so a host that follows it SHOULD
NOT locally re-sort it — that would discard the tradeoff the ranking exists
to provide. But nothing in this AIP compels a buyer to follow it: on a
decentralized network a buyer MAY disregard the suggestion, ask a different
routing peer it trusts more, or blend several routing peers' rankings — the
routing peer proposes, the buyer's own client decides. Separately, the
routing peer's own `constraints` filtering is advisory only, since a host
has no way to verify a remote routing peer actually applied it correctly:
a `Router` implementation MUST still re-apply the buyer's own
price/trust/allow-block policy itself, inside `selectRoute`, dropping
disallowed candidates before ever returning the list to the host. Policy
filters the given order in place; it never re-ranks it.

**Sentinel strings stay inside the plugin.** A host that recognized one
router's sentinel model string by name would privilege that implementation
over any other `Router` a buyer might load. The host forwards the request
unmodified; only the plugin knows what its own sentinel means.

**Pricing is deliberately out of scope here.** This AIP treats a routing
peer as free, the same bootstrapping path attestation took — bundling a
pricing scheme into this proposal would force reviewers to accept or reject
both together. A companion pricing AIP can specify whatever metered or
subscription mechanism a priced routing peer needs, without reopening
anything specified here.

## Backwards Compatibility

This proposal is additive. A peer that advertises no `routing.v1` capability
is unaffected by this AIP; a `Router` implementation that does not implement
either of the two new optional methods is unaffected and behaves exactly as it
does today. The `/_antseed/route` path is newly reserved, so a seller MUST
NOT route it to a provider — though it was never a valid model or service
id, so no existing conforming seller can already be using it for anything
else. No metadata codec
version bump, no `METADATA_VERSION` change, and no payment-message change is
required. Mixed-version networks interoperate: a routing-aware buyer skips
peers that advertise no `routing.v1` capability, and a routing-advertising
peer is ignored by buyers that do not implement `selectRoute` at all, exactly
as [AIP-3](./aip-3.md) describes for verifier capabilities.

## Security Considerations

**Unmetered ranking is a denial-of-service surface.** Ranking MAY be
expensive (a separate scoring process). This AIP defines no payment gate —
an operator MUST put its own payment or cost-control gate in front of a
routing peer before running it against real traffic.

**Prompt content leaves the buyer's device.** `inputMessage` gives the
routing peer itself access to conversation content on every routed request —
in addition to, not instead of, whichever inference seller ultimately
answers it. Routing a request means two parties see the prompt instead of
one. A buyer SHOULD trust a routing peer the way it trusts any seller it
sends prompts to, and SHOULD be able to see which peer identity it's routing
through.

**A dishonest routing peer can steer, but never override, a buyer's policy.**
Even though following a routing peer's ranking is the host's own choice, not
a requirement (Rationale), a compromised routing peer could still bias its
ranking toward affiliated sellers, hoping a host follows it uncritically.
This is bounded regardless: a `Router` implementation MUST re-apply the buyer's own
`constraints` locally before dispatch rather than trusting the routing peer's
own filtering (which is advisory, not authoritative — see Rationale), so a
routing peer can bias an ordering but cannot force a buyer to pay outside its
own price, trust, or allow/block bounds.

**Plugins never hold a buyer's signing key.** None of this AIP's own new
`Router` methods expose signer access, since this AIP defines no signing
mechanism. Any signing capability a companion pricing AIP adds MUST follow
the same closure-based pattern established elsewhere in this protocol: a
`Router` — including a third-party one — gets a host-provided closure to
call, never the buyer's actual private key or a handle that can sign
arbitrary messages. A host implementation MUST NOT expose its payment
manager or signer directly to plugin code.

## Copyright

Copyright and related rights waived via [CC0](../LICENSE).

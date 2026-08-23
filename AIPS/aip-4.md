---
aip: 4
title: Proof-Carrying Wash-Trading Enforcement
description: Defines ZK-proven wash-trading findings that reduce recognized-usage rewards in proportion to proven fabrication, anchored to a public permissionless block-hash store.
author: Shahaf Antwarg (@kotevcode)
discussions-to: https://github.com/AntSeed/loop-proof/pull/1
status: Draft
type: Standards Track
category: Contracts
created: 2026-08-18
requires: 2
---

## Abstract

This AIP specifies how wash-trading findings become enforceable on-chain. A
finding is a **proof-carrying claim**: a zkVM guest program re-verifies raw
Base evidence (receipts and transactions, authenticated by Merkle-Patricia
inclusion proofs against block headers) and checks a fixed mechanical
predicate over it. The guest's verification key **is** the rule; its public
journal contains the subject, the proven fabricated volume, the subject's own
settled volume for comparison, a claim identifier, and the
`(blockNumber, blockHash)` pairs the evidence came from. An immutable,
ownerless registry contract on Base verifies the proof, authenticates every
journal block reference against the existing public **Chainlink BlockhashStore**
(`0x78b69899C8cD252126cBB1A50171ec37286C3877`), and permanently records the
proven volume. Policies installed through AIP-2's hooks then reduce
recognized-usage points and withhold locked rewards **in proportion to the
share of the subject's own volume that was proven fabricated**, making
wash-traded volume emission-ineligible.

Enforcement is deliberately keyed to a ratio rather than an absolute amount: a
volume threshold in a public immutable rule would simply tell an operator how
finely to split its activity across seller identities to stay beneath it, while
a ratio makes such splitting counterproductive.

Because submission is permissionless and the record is permanent, the predicates
specified here prove a **conserved value loop** — capital injected, volume
settled, and capital returned, bound together at comparable scale and
attributed to one funder through the protocol's own cumulative accounting —
rather than the existence of transfers between related wallets. The companion
wash-trading detection AIP calibrates the predicate parameters against real
network traffic before a registry is deployed.

There is no committee, no attestation, no optimistic challenge window, and no
AntSeed-operated block-hash infrastructure: anyone can produce a claim for any
covered period at any time, and nothing in the system requires scheduled
maintenance. Historical block hashes outside EIP-2935's 8,191-block window are
obtained from the BlockhashStore, whose entries are correct by construction
regardless of who writes them, and which anyone can extend permissionlessly.

## Motivation

AIP-2 makes recognized usage feed on-chain trust scores and ANTS emissions.
That creates a direct incentive to fabricate volume: a seller funds sock-puppet
buyers, routes deposits through hop wallets, settles channels against itself,
and cycles the funds back. Off-chain detection of these patterns is
straightforward; the hard problem is acting on a detection without introducing
a trusted party. A finding that zeroes a seller's rewards is an adversarial,
high-stakes claim — if it rests on a multisig, committee vote, or company API,
the whole trust system inherits that weakness.

The standing requirement is therefore: **any finding that affects seller
scoring MUST be proven, never attested.** Two obstacles make this non-trivial:

1. **Evidence is historical.** An enforcement period spans months of Base
   blocks, while the EVM exposes block hashes only through the `BLOCKHASH`
   opcode (256 blocks) and the EIP-2935 ring buffer (8,191 blocks, a few hours
   on a two-second chain). No predeploy, scheduled hardfork, or OP Stack
   mechanism reaches deeper history, and none is on the visible roadmap.
2. **Enforcement must be permissionless and perpetual.** Anyone MUST be able
   to construct and submit a claim at any future time without AntSeed's
   cooperation, without a keeper cron staying alive, and without any party
   having pre-provisioned data for them.

A survey of existing infrastructure (see Rationale) found no live third-party
service that meets both constraints. This AIP composes two things that do:
custom zkVM predicates for the evidence, and an existing, unowned, widely-fed
public contract for the historical block hashes.

## Specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in RFC 2119.

### Architecture overview

```
off-chain                                 |  on Base
                                          |
detector (indexers, heuristics)           |
   │  candidate claims                    |
   ▼                                      |
planner ── selects evidence blocks        |   Chainlink BlockhashStore
   │                                      |   (existing, unowned)
   ▼                                      |        ▲          │
backfill script ── storeVerifyHeader ─────┼────────┘          │ getBlockhash(n)
   │                                      |                   ▼
   ▼                                      |   AntseedWashTradingRegistry
witness materializer ── MPT proofs        |     - zkVM verifier + pinned vkey
   │                                      |     - journal block-ref check
   ▼                                      |     - permanent proven-volume record
zkVM guest ── predicate + journal ────────┼──────────────────►│
   (proof via any prover / open market)   |                   ▼
                                          |   AIP-2 policies (setPointsPolicy)
                                          |     points scaled by f(washRatio)
```

Only the registry and the points/claim policies are new deployments. The
BlockhashStore already exists; the detector, planner, and prover are
off-chain tooling with no trust role — a wrong or malicious off-chain
component can only produce claims that fail verification.

### Evidence authentication (common to all predicates)

A guest receives, per referenced block: the RLP block header, and for each
referenced receipt or transaction an MPT inclusion proof against that header's
`receiptsRoot` or `transactionsRoot`. The guest MUST:

1. Verify every inclusion proof.
2. Reject duplicate block, receipt, transaction, or log references.
3. Reject evidence from reverted receipts.
4. Reject evidence outside the fixed enforcement period.
5. Commit `(header.number, keccak256(rlp(header)))` for every referenced
   block to the journal.

Where a predicate attributes an action to an address (e.g. "the funder funded
this buyer"), attribution MUST come from recovering the transaction signer,
not from log topics alone.

Predicates that read protocol accounting state (the `LEDGER` witness below)
additionally receive, per referenced block, an MPT account proof against the
header's `stateRoot` and a storage proof against the resulting account root.
The guest MUST verify both, and MUST bind the storage slot to the deployed
contract address it commits to. Because the header is already authenticated by
its hash, the same block reference covers receipts, transactions, and state
uniformly. Fetching these witnesses requires an archive-capable Base RPC;
this is an off-chain materialization concern with no trust role.

### Predicates

The guest program's verification key is the authoritative definition of each
predicate. Changing any constant produces a different vkey and therefore a
different rule requiring a new registry. The parameters below are named with
the constraints they must satisfy; their calibration against observed network
traffic is produced by the companion wash-trading **detection** AIP.

Every predicate in this family proves the same thing: a **conserved value
loop**. Fabricated volume is volume settled with capital that the same party
put in and got back. The predicate therefore measures three magnitudes —
capital injected, volume settled, capital returned — and flags only when all
three are bound together in one circuit at comparable scale. Transfers between
related wallets, by themselves, are never sufficient.

**P0_CLOSED_LOOP** — flags one seller `S`.

Roles: a funder `F`, the seller `S`, and a buyer cohort `B` of distinct buyer
addresses, bounded above by a witness-sizing limit. Evidence sets, all authenticated per *Evidence
authentication*:

- `FUND` — transfers from `F` crediting each buyer `b ∈ B`, in any of three
  forms: a direct USDC transfer to `b`; a `Deposits.deposit(b, …)` call whose
  same-receipt USDC transfer from `F` matches the deposited amount; or a
  native transfer to `b`. Every funding transaction MUST be signed by `F`.
- `SETTLE` — successful `ChannelSettled(channelId, buyer, seller = S, …)`
  events on the deployed AntseedChannels contract with `buyer ∈ B`.
- `RETURN` — a USDC path carrying value from `S` back to `F`, either directly
  or through at most `H_max` intermediate hops, each hop authenticated and
  time-ordered.
- `LEDGER` — for each `b ∈ B`, a proof of the protocol's own cumulative
  deposit accounting for `b` at the period bounds (see *Attribution* below).

The predicate MUST hold:

1. **Measurement.** `Σ SETTLE` is the fabricated volume the claim establishes.
   The guest MUST commit this magnitude to the journal; it is the input to the
   proportional effect defined in *Policy binding*. The predicate defines no
   volume floor and no minimum cohort size beyond what conservation itself
   requires — a single funded buyer forming a conserved circuit is already a
   proven loop. Thresholds of this kind would only tell an operator how small
   to slice its activity.
2. **Funding coverage.** `Σ FUND ≥ α_fund · Σ SETTLE`. The funder's capital
   MUST account for the volume it is alleged to have fabricated.
3. **Attribution.** For each `b ∈ B`, the capital `b` settled with MUST be
   `F`'s. This is established from `LEDGER`: the increase in `b`'s cumulative
   protocol deposits over the period MUST be matched, within `ε_ledger`, by
   the `FUND` evidence naming `F` as payer. Using the protocol's own on-chain
   cumulative accounting as the completeness witness makes this an `O(1)`
   check per buyer against an authenticated state root, rather than a search
   over the buyer's entire transaction history.
4. **Ordering.** Each counted settlement MUST occur strictly after the funding
   that covers its buyer, and every `RETURN` element MUST occur after the
   earliest settlement it is claimed to close.
5. **Return.** `Σ RETURN ≥ α_return · Σ SETTLE`, arriving at `F`. Where the
   return travels through intermediaries, each hop MUST forward at least
   `ρ_hop` of what it received and the path MUST complete within `T_path`.
   Path length is bounded by `H_max` only so the guest can size its witness
   statically; `H_max` MUST be set well above observed laundering topologies
   so that it is never the binding constraint. What qualifies a path is the
   per-hop retention and the end-to-end total reaching `F` — a conduit is a
   conduit whether it runs through two wallets or ten, and a rule that stops
   at a small fixed length is evaded by adding one more address.
6. **Circularity.** `F`, `S`, and `B` MUST form one circuit: the same capital
   accounted in (2) is the capital returned in (5). Where `S == F` the return
   leg is satisfied by identity, and requirements (1)–(4) still apply in full.

Parameters and their constraints: `α_fund` and `α_return` are coverage
fractions that MUST be near unity, since a loop that fabricates volume must
supply and recover substantially all of it; `ρ_hop` is per-hop retention,
likewise near unity; `T_path` bounds the end-to-end return; `ε_ledger` is the
tolerance on the ledger reconciliation in requirement (3); `H_max` is discussed
below. Every parameter is a *ratio or a bound on evidence shape*, never a
magnitude of volume, so no parameter tells an operator a size to stay under.
Values are fixed by the detection AIP.

**P0_RECIPROCAL** — flags both wallets `A`, `B` of one normalized pair, and
proves the same conservation in its circular form: a pair recycling one pool
of capital between them. Evidence: successful settlements in both directions,
plus `LEDGER` proofs for both wallets. The predicate MUST hold:

1. **Measurement.** The combined settled volume between the pair is the
   fabricated magnitude and MUST be committed to the journal, per wallet.
2. Directional volume reciprocity `≥ β` — neither side is a net seller at
   scale.
3. **Self-financing.** Net external capital entering the pair over the period
   MUST be at most `(1 − α_self)` of the combined settled volume, established
   from `LEDGER`. The pair MUST be shown to have settled its volume out of
   receipts from each other rather than out of capital raised elsewhere.

Parameters: `β` is the reciprocity fraction, high enough that ordinary two-way
trade does not reach it; `α_self` is the self-financing fraction and MUST be
near unity. Both are ratios; as above, the predicate sets no volume or count
floor. Values are fixed by the detection AIP.

Requirement (3) is what separates recycled capital from genuine two-way trade:
two providers who buy from each other with independently earned funds inject
external capital proportional to their volume and are therefore outside the
predicate.

### Journals

Journals MUST be minimal: the subject(s); per subject, the proven fabricated
volume and the subject's period-end settled volume read from `AgentStats`; a
claim identifier binding the claim to its subjects and evidence set; and the
sorted `(uint64 blockNumber, bytes32 blockHash)[]` array of referenced blocks,
ABI-encoded. Both volumes are on-chain because the effect is proportional to
their ratio and that ratio must be fixed at proving time (see *Policy
binding*); the claim identifier is on-chain so repeated submission of the same
claim is idempotent. Cohort membership,
intermediate arithmetic, and the evidence manifest stay off-chain; the chain
never duplicates predicate logic.

### Block-hash anchoring: the Chainlink BlockhashStore

The registry MUST authenticate every journal block reference by calling
`getBlockhash(blockNumber)` on the BlockhashStore at
`0x78b69899C8cD252126cBB1A50171ec37286C3877` (Base mainnet) and requiring
equality with the journal's hash. This contract is chosen for the following
properties, each independently verifiable against the deployed bytecode and
live chain state:

- **Immutable and unowned.** Its ABI is exactly four functions (`store`,
  `storeEarliest`, `storeVerifyHeader`, `getBlockhash`); the verified source
  contains no owner, roles, proxy, `delegatecall`, or `selfdestruct`; both
  EIP-1967 proxy slots are zero.
- **Correct by construction, independent of the writer.** `store(n)` reads
  the hash from the `BLOCKHASH` opcode (Base consensus). `storeVerifyHeader(n,
  header)` accepts only a header whose keccak equals the already-stored hash
  of block `n+1`, then stores that header's `parentHash` — only the true
  header satisfies the check, so only the true hash can be stored. No caller,
  including a malicious one, can store a wrong hash.
- **Provenanced.** The Base VRF v2.5 Coordinator listed in Chainlink's
  official documentation (`0xd5D517aBE5cF79B7e95eC98dB0f0277788aFF634`)
  returns this address from `BLOCKHASH_STORE()`. The contract has shipped
  with Chainlink VRF since v1 and is fed continuously by VRF node feeders as
  a side effect of normal VRF operation.
- **Densely populated.** Because the feeders run continuously, stored blocks
  recur throughout Base history at intervals measured in seconds of chain
  time, so an arbitrary evidence block is typically a short walk from an
  existing entry. Implementations MUST measure actual coverage for their
  period rather than assuming it; density affects backfill cost only, never
  correctness.

**Backfill.** Evidence blocks not yet stored MUST be backfilled before claim
submission by anyone (permissionlessly): walk `storeVerifyHeader` downward
from the nearest stored block above the target, supplying each intermediate
RLP header. Every walked block is stored permanently, so backfills accumulate
as shared public infrastructure. Density is a cost optimization, not a
dependency: in the degenerate case where no nearby block is stored, a
submitter calls `store(n)` on any block within the current 256-block window
and walks from there.

The registry MUST NOT depend on any AntSeed-operated block-hash
infrastructure. This AIP explicitly supersedes the previously planned
`AntseedBlockhashKeeper` (checkpoint cron) and any bespoke historical
checkpoint oracle: neither SHALL be deployed.

### Registry contract

`AntseedWashTradingRegistry` MUST be immutable and ownerless, constructed
with: the zkVM verifier address, the pinned guest verification key(s), the
BlockhashStore address, and the enforcement-period constants. It exposes:

```solidity
function submitClaim(bytes calldata proof, bytes calldata journalData) external;
function washRatioBps(address subject) external view returns (uint16);
event SubjectProven(
    address indexed subject,
    bytes32 indexed claimId,
    uint256 washVolume,
    uint256 settledVolume,
    address indexed submitter
);
```

`submitClaim` MUST: verify `proof` against the pinned vkey over `journalData`;
decode the journal; check every block reference against the BlockhashStore; and
record, per subject, the proven fabricated volume together with the
period-end settled volume the journal commits, clamping their ratio to at most
one. Records are permanent.

Because two claims against one subject may reference overlapping settlements,
the registry MUST NOT sum their volumes — that would double-count evidence and
overstate the penalty. It MUST instead retain the **greatest** proven ratio
recorded for a subject. This never overstates what was proven, at the cost of
understating when genuinely disjoint loops are proven separately, which is the
correct direction of error under this AIP's false-positive-first priority. A
claim already recorded is idempotent.

Submission is permissionless; `msg.sender` is recorded for future bounty
attribution (out of scope here). A new rule, period, or predicate version is a
new guest and a new registry, switched in via AIP-2's policy hooks — the
registry itself never upgrades.

### Policy binding

Enforcement is **proportional to proven fabrication, measured as a share of
the subject's own volume** — never keyed to an absolute amount. Define

```
washRatio(subject) = provenWashVolume(subject) / settledVolume(subject)
```

Both quantities MUST be measured from the same source in the same unit, so
that the numerator is by construction a subset of the denominator. The
deployed `AntseedChannels` contract already provides this: `settle()`
accumulates each settlement's `delta` into `AgentStats.totalVolumeUsdc`,
readable via `getAgentStats(agentId)` — the identical quantity the predicate
counts from `ChannelSettled`. No new accounting contract is required for the
denominator.

`AgentStats.totalVolumeUsdc` is lifetime-cumulative and monotonic, so it MUST
NOT be read live at policy-evaluation time: doing so would make the penalty
depend on when it is evaluated and would let a subject dilute a proven ratio
by accumulating volume afterwards. The guest MUST instead read that storage
slot at the enforcement period's end block through the same state-proof
machinery used for the `LEDGER` witness, and commit the value to the journal
alongside the proven volume. The ratio is then fixed at proving time,
deterministic, and permanent.

Two edge cases MUST be handled explicitly. `AgentStats` accrues only when the
seller has a non-zero staked `agentId`, so a subject may have a zero or
partial denominator; and a subject whose settlements predate its identity may
yield a numerator exceeding the denominator. In both cases the ratio MUST
clamp to 1 rather than revert or divide by zero — a subject with no recognized
volume has no points to scale in any event.

The ratio is the quantity the policies act on:

- **Points policy:** recognized-usage points are scaled by `f(washRatio)`,
  where `f` is monotonically decreasing with `f(0) = 1`, reaches zero at a
  ratio `θ` above which the subject is treated as a wash operation outright,
  and is **superlinear** below `θ` — the loss MUST exceed the fabricated
  amount itself, or fabricating is a free roll whose expected value stays
  positive whenever detection is uncertain.
- **Seller claim policy:** locked reward pools are withheld on the same
  schedule, and fully frozen at or above `θ`. The wash check takes precedence
  over any inner vesting policy.

`f` and `θ` are fixed by the detection AIP alongside the predicate parameters.

This construction has no threshold to structure beneath. Splitting a fabricated
volume across many seller identities does not reduce exposure — it raises it,
because each identity then carries a high `washRatio` against its own small
recognized volume, while the same fabrication concentrated in one high-volume
identity would dilute. Conversely a large, mostly honest seller is not
destroyed by a small proven loop, which keeps the permanent penalty
proportionate to what was actually proven.

### Proving

The predicate guests MAY be built for any zkVM that has an immutable verifier
deployed on Base (both the RISC Zero verifier router and the SP1 verifier
gateway qualify); the choice is pinned per registry at deployment. Proof
generation is permissionless in practice via open proving markets (e.g.
Boundless, Succinct Prover Network) or local CPU proving; nothing in this
specification depends on who proves. Guest builds MUST be reproducible so any
party can independently derive the pinned vkey from source.

## Rationale

**Why proofs and not attestation.** A committee or multisig attestation was
explicitly rejected: it reintroduces exactly the trusted party the trust
system is meant to remove, and a permanent, seller-poisoning flag is the worst
possible place for one.

**Why the predicate proves conservation.** Submission is permissionless and a
flag is permanent, so the design assumes the claimant is adversarial and
chooses the funder, the cohort, and the evidence. Under that assumption the
only durable defense is to require the claim to exhibit a property that
honest activity cannot accidentally satisfy. Value conservation is that
property: an honest seller's volume is settled with capital its buyers raised
independently, so no single party can show funding coverage, attribution, and
proportional return at the scale of that volume. A fabricated loop must show
all three by construction, because that is what it is. Anchoring the predicate
to conserved magnitudes rather than to the existence of transfers is what makes
the flag safe to make permanent.

**Why the effect is a ratio and the predicate has no volume floor.** Any
absolute threshold in a public, immutable rule is an instruction: it tells an
operator exactly how small each unit of its activity must be to escape. A floor
on fabricated volume is escaped by splitting one operation across several
seller identities, each sized beneath it — and identities are cheap relative to
the emissions at stake. Ratios have no such edge to sit under. Measuring
proven fabrication against the subject's own recognized volume inverts the
incentive: fragmenting an operation raises each fragment's ratio, because the
fabricated volume is being divided by a correspondingly smaller honest base,
so the fragments are penalized harder than the whole would have been. The same
measure keeps the penalty proportionate in the other direction, so that a
mostly honest seller is not permanently destroyed by one small proven loop —
which matters because the record is permanent and submission is open to
anyone. Superlinearity below `θ` is what stops proportionality from becoming a
free roll: if the penalty merely cancelled the fabricated amount, the expected
value of fabricating would remain positive under any detection probability
below one.

**Why return-path length is not a threshold.** The rule is public and
immutable, so any constraint an adversary can satisfy by adding one more
wallet is not a constraint at all — it is a published evasion recipe with a
gas-fee price. Path length is such a constraint; per-hop retention and
end-to-end conservation are not, because they bound the *value* that must
survive the trip rather than the number of addresses it visits. The only
genuine reason to bound length is that a longer permitted path gives more
opportunity for an unrelated sequence of honest payments to coincidentally
form a value-preserving chain ending at an address the claimant nominates as
the funder. That risk is already suppressed by requiring each hop to preserve
`ρ_hop` of the amount within one bounded window: chains of independent
economic activity do not hold value to a near-unity fraction step after step,
while conduits do. `H_max` is therefore set by witness sizing and coincidence
margin, generously, and calibrated with the other parameters.

**Why protocol accounting supplies completeness.** Attribution (requirement 3)
is a statement about *all* of a buyer's funding, which a search over evidence
can never establish — absence of evidence is not evidence of absence. Rather
than proving completeness by walking every block in the period, the predicate
reads the protocol's own cumulative per-buyer deposit accounting at the period
bounds through authenticated state proofs. The contract's counter is already a
complete summary of what entered, so one storage proof per buyer replaces an
exhaustive history search: `O(1)` witnesses instead of `O(blocks)`, with the
same guarantee. This is the reason state proofs are in scope alongside receipt
proofs, and why the enforcement period is bounded — the bounds are where the
ledger is read.

**Why the Chainlink BlockhashStore and not bespoke infrastructure.** The
obvious alternative is to prove the block hashes ourselves: walk the
parent-hash chain from an EIP-2935-reachable anchor back across the period in
zkVM epochs, aggregate the epoch proofs recursively, and commit the result to a
purpose-built accumulator oracle. An earlier iteration did exactly that. It was
correct, and it dominated both the code size and the proving cost of the whole
system — for a fixed range it could never extend, and requiring maintenance
that would outlive whoever set it up.

The alternatives fall into classes, each disqualified structurally rather than
incidentally. This survey is point-in-time and SHOULD be repeated before
deployment, but the structural reasons are durable:

- *Native chain mechanisms.* Neither the OP Stack nor announced hardforks
  expose block hashes beyond the EIP-2935 window; cross-chain message
  primitives carry short expiry windows unsuited to historical evidence.
- *ZK coprocessors.* The projects that marketed historical receipt/event
  proving have largely shut down, pivoted away, or do not serve Base; those
  still operating route proving through their own infrastructure, and their
  low-cost modes interpose a staked committee.
- *Third-party block-hash accumulators.* The architecture is right, but
  deployed instances on Base carry no accumulated data and gate their
  off-chain proof path behind an admin-settable registry.
- *Managed event-proving services.* Each substitutes an operator signature,
  validator set, or hosted API for a proof — placing a trusted party exactly
  where this AIP requires math — and several cannot prove logs at all.
- *Deploy-time pinned root* (compute the period's block hashes off-chain, pin
  a Merkle root in the constructor). Cheap and publicly re-derivable, but
  establishing the root is a one-time privileged act by the deployer, which
  violates the anyone-at-any-time requirement.

The BlockhashStore is the remaining option and dominates: it already exists,
carries no owner or writer trust, has long-standing audit exposure as VRF
infrastructure, is fed continuously by economically unrelated actors, and any
gap can be closed permissionlessly by whoever needs it. Adopting it removes the
accumulator, the checkpoint oracle, the keeper cron, and the recurring proving
cost, and replaces them with a one-time backfill whose cost is ordinary Base
gas proportional to the walk length.

**Why the walk-based fallback still matters.** The store's density is an
empirical observation, not a guarantee. The specification therefore defines
correctness in terms of `store` + `storeVerifyHeader` semantics only, which
hold even if VRF activity on Base ceased permanently.

**Parameter calibration.** The α, β, and ρ parameters set where honest
activity ends and a proven loop begins, so they are calibrated empirically
rather than chosen here: the detection AIP measures funding-coverage and
reciprocity distributions across real network traffic and fixes values that
leave observed honest behavior outside the predicate with margin. Because the
values compile into the guest and thus into the vkey, calibration MUST
complete before a registry is deployed and bound to a live policy.

**Fixed-period constants.** Baking the period into the guest makes each
registry a closed, auditable, one-shot rule ("vkey = rule") at the cost of
redeploying per period. This is intentional: an open-ended rule would need
upgradable thresholds, which reintroduces governance over findings.

## Backwards Compatibility

Purely additive on the protocol side; no wire-format or metadata changes.
Contract-side, enforcement activates through AIP-2's existing
`setPointsPolicy` / seller-claim-policy hooks — recognized-usage aggregates
already on-chain are unaffected, and sellers with no proven volume see no behavioral
change. The previously planned keeper/checkpoint-oracle components are
superseded before ever being deployed, so nothing is deprecated on-chain.

## Test Cases

The reference predicate library carries native (non-zkVM) tests that MUST
pass for any implementation: tampered `receiptsRoot`/`transactionsRoot`
rejection, duplicate evidence rejection, reverted-receipt rejection,
funding-before-settlement ordering, exact threshold boundaries for every
parameter, signer-recovery attribution, state-proof binding to the committed
contract and slot, and period-window enforcement.

Predicate tests MUST include vectors that the predicate REJECTS, covering the
honest shapes nearest the boundary: funding present but below `α_fund` of the
settled volume; funding covering the volume but with no proportional return;
a buyer whose ledger delta exceeds the funder-attributed amount by more than
`ε_ledger`; a seller that pays rebates to buyers it also serves without a
conserved circuit; and a reciprocal pair whose settled volume is matched by
external capital entering the pair. Registry tests MUST cover: valid proof with
correct block refs accepted; valid proof with one journal hash absent from the
BlockhashStore rejected; valid proof with a mismatching stored hash rejected;
replayed claims idempotent; records irrevocable; a second claim against the
same subject retaining the greater proven volume rather than summing.

Policy tests MUST cover the ratio semantics: that `f(washRatio)` is applied
against the subject's own settled volume rather than an absolute amount; that a
fabricated volume split across several seller identities yields at least as
much total penalty as the same volume concentrated in one; that a subject at or
above `θ` receives zero points and a full pool freeze; that settlement activity
occurring after the enforcement period does not change an already-recorded
ratio; and that a subject with a zero or partial `AgentStats` denominator
clamps to a ratio of one instead of reverting.

## Reference Implementation

- Evidence-authentication and proving tooling:
  [AntSeed/loop-proof#1](https://github.com/AntSeed/loop-proof/pull/1). Its
  MPT inclusion, signer-recovery, journal-encoding, and planner machinery are
  adopted as-is and extended with the state/storage-proof verification the
  `LEDGER` witness requires. Its `checkpoint/` accumulator workspace and
  oracle are superseded by the BlockhashStore anchoring specified here. Its
  predicate constants are superseded by the conserved-loop requirements
  above, with final values from the detection AIP.
- Registry and policies: the `AntseedWashTradingRegistry` /
  points-policy / seller-claim-policy line of
  [AntSeed/antseed#895](https://github.com/AntSeed/antseed/pull/895), with
  `blockhashSource` bound to the BlockhashStore.

## Security Considerations

**Framing resistance.** A record permanently reduces a seller's rewards and
withholds locked pools in proportion to the volume proven against it, and
anyone may submit a claim, so the security goal is that no party can satisfy
the predicate against a seller that did not wash-trade. Proportionality also
bounds the damage of any residual framing: an attacker who could establish a
loop over a small slice of a large honest seller's volume moves that seller's
ratio slightly, rather than destroying it outright. The conserved-loop requirements are what deliver this: an attacker
targeting an honest seller would have to supply capital covering `α_fund` of
that seller's real settled volume, show through the seller's buyers' protocol
ledgers that this capital — and not the buyers' own — financed that volume,
and then demonstrate `α_return` of it coming back. The cost of framing
therefore scales with the victim's genuine volume and cannot be met at all
while the buyers' ledgers show independent funding, which is the honest case.
Small transfers to a seller's buyers, rebates paid to one's own customers, and
mutual trade between two providers are all outside the predicate by
construction.

An unproven loop (false negative) is the milder failure: fabricated volume keeps
earning until a later predicate version catches it. The design accordingly
prioritizes false-positive resistance over coverage, and parameter calibration
(Rationale) resolves the remaining margin empirically.

**zkVM soundness.** The system's integrity reduces to the soundness of the
chosen proof system and the correctness of the pinned verifier contract on
Base. Reproducible guest builds are REQUIRED so the vkey is independently
derivable; the registry pins both verifier and vkey immutably.

**BlockhashStore assumptions.** (1) *Header format:* `storeVerifyHeader`
hard-codes the RLP layout of headers (parentHash at a fixed offset of an
`0xf9`-prefixed list). A future Base hardfork changing header serialization
would break new backward walks until a successor store exists; hashes already
stored, including any period fully backfilled beforehand, are unaffected. (2) *Reorged entries:* `store(n)` reads the sequencer chain; a
hash stored in the instant before an unsafe-head reorg could persist as an
orphan entry, and an attacker holding the orphan header could extend fake
lineage below it via `storeVerifyHeader`. Mitigations: any wrong entry is
correctable by anyone (re-walking from a canonical stored block overwrites,
and writes converge to the canonical value); claim submitters SHOULD
cross-check referenced entries against independent RPCs before submission;
evidence in practice is weeks-to-months old and L1-finalized, where orphan
headers for the referenced heights do not exist. The registry only ever
*reads* the store, so a bad entry can at worst make a specific claim
submittable/unsubmittable until corrected — it cannot corrupt an honest
proof's meaning, because the proof binds the true header contents.

**Liveness.** No component requires scheduled operation. If Chainlink VRF
activity on Base stopped, walk gaps grow but self-service `store()` within
the 256-block window keeps the system usable by any submitter, forever.

**Sybil / griefing.** Claim submission is permissionless; invalid proofs
revert and cost only the submitter. Duplicate valid claims are idempotent.
Backfill griefing is impossible (writes cannot store wrong values) — at
worst an attacker wastes their own gas storing blocks nobody needs.

**Detector compromise.** The off-chain detector, planner, and prover are
untrusted by construction: they can withhold claims (censorship is bounded by
permissionless submission from anyone else) but cannot cause a false record.

## Copyright

Copyright and related rights waived via [CC0](../LICENSE).

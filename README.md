# Multi-Signature Wallet

An **M-of-N multi-signature wallet** in Solidity 0.8. A group of owners shares one
wallet; any owner can propose a transaction, and it is executed only after a
minimum number of owners (the threshold) has approved it. The wallet can send
Ether, ERC20 tokens or any other contract call, and the owners can change the
owner set or the threshold, but only by approving that change through the
wallet itself.

| | |
|---|---|
| Contract | [`contracts/MultiSigWallet.sol`](contracts/MultiSigWallet.sol) |
| Tests | [`test/MultiSigWallet.js`](test/MultiSigWallet.js): 52 tests, 100% line coverage |
| Scripts | [`scripts/deploy.js`](scripts/deploy.js), [`scripts/demo.js`](scripts/demo.js) |
| Demo output | [`docs/demo-output.txt`](docs/demo-output.txt) |
| Stack | Hardhat 2, ethers v6, Mocha/Chai, OpenZeppelin Contracts 5 (`ReentrancyGuard` only) |

---

## 1. Research

### Why multi-sig wallets matter

A normal Ethereum account is controlled by **one private key**. If that key is
lost, the funds are gone; if it is stolen or its holder acts dishonestly, the
funds are taken. A multi-signature wallet removes this single point of failure by
requiring **M independent approvals out of N owners** before anything moves.

- **DeFi treasuries and protocols.** DAOs, protocol teams and funds keep their
  treasuries in multi-sigs, so no single team member can drain them.
- **Admin keys and upgrades.** Upgradeable contracts, oracles and bridges are
  often controlled by a multi-sig, so parameter changes and upgrades need
  several signers.
- **Governance.** A multi-sig is the simplest on-chain governance: a committee
  votes by confirming, and the result is executed automatically once the
  threshold is met. It often backs up or executes token-holder governance.
- **Personal security.** Keys spread across devices or people (e.g. 2-of-3)
  survive the loss of one key and the theft of one key.

### Existing designs reviewed

| | ConsenSys / Gnosis **MultiSigWallet** (2017) | **Safe** (formerly Gnosis Safe) |
|---|---|---|
| Approval model | On-chain: each owner sends a `confirmTransaction` tx | Off-chain signatures (EIP-712), all submitted in one `execTransaction` |
| Storage of approvals | `confirmations[txId][owner]` mapping | Nothing stored; signatures checked at execution, replay blocked by a `nonce` |
| Owner management | `addOwner` / `removeOwner` / `replaceOwner` / `changeRequirement`, callable only by the wallet | Same idea (`onlyWallet`-style `authorized`), owners kept in a linked list |
| Counting | Counts confirmations of **current** owners at execution | Verifies `threshold` valid owner signatures |
| Extensibility | None | Modules, guards, fallback handler, `delegatecall` operations |
| Deployment | One contract per wallet | Minimal proxy pointing to a shared singleton |

**Patterns this project adopts:** the explicit on-chain lifecycle and the
`onlyWallet` owner management of MultiSigWallet (simple to audit and to test),
counting confirmations of current owners only, and a 50-owner cap.

**What it does differently:** submission does not auto-confirm and confirmation
does not auto-execute, so each step of the lifecycle is a separate, visible
action; errors are Solidity custom errors; execution is protected by both
checks-effects-interactions and a reentrancy guard.

### Lessons from real incidents

- **Parity multi-sig, July 2017.** The wallet's library had an unprotected
  initialization function reachable through `delegatecall`; an attacker
  re-initialized three wallets, made himself owner and took about 153,000 ETH.
  *Lesson:* initialization must be impossible to call twice. Here the owners are
  set in the **constructor**, which can only run once.
- **Parity multi-sig, November 2017.** Someone initialized the shared library
  contract itself and self-destructed it, freezing about 513,000 ETH in every
  wallet depending on it. *Lesson:* avoid shared logic that wallets cannot live
  without. This wallet is a single self-contained contract with no `delegatecall`
  and no `selfdestruct`.
- **Bybit, February 2025.** Attackers compromised the Safe web interface used by
  the signers, who then approved a transaction that looked routine but replaced
  the wallet's logic, and about $1.5 billion was stolen. *Lesson:* a multi-sig
  only protects you if signers verify **what** they sign. The contract can enforce
  the threshold, but not human review; this wallet keeps every proposal readable
  on-chain (`getTransaction`) and does not support `delegatecall`, which
  removes that specific attack path.

---

## 2. Requirements

| Requirement | Decision |
|---|---|
| Number of owners | 1 to 50 (`MAX_OWNERS`), set at deployment, changeable later |
| Confirmations required | `required`, with `1 ≤ required ≤ owners`; validated on every change |
| What can be proposed | Any call: Ether transfer (`value`), ERC20 transfer or any contract call (`data`), or a call to the wallet itself (owner management) |
| Who can act | Only owners can submit, confirm, revoke and execute. Anyone can deposit Ether |
| Lifecycle | **Submit → Confirm (/ Revoke) → Execute**, each a separate transaction |
| Revocation | An owner can withdraw their own confirmation until the transaction is executed |
| Execution | Any owner may execute once confirmations from current owners reach `required` |
| Dynamic ownership | Implemented: add, remove, replace owner and change threshold, **only via an approved wallet transaction** |

---

## 3. Contract design

### Data structures

```solidity
struct Transaction {
    address to;       // destination: an account (Ether) or a contract (call)
    uint256 value;    // wei to send
    bytes   data;     // calldata, empty for a plain Ether transfer
    bool    executed; // set once, before the external call
}

address[] private owners;                                     // ordered list, for iteration
mapping(address => bool) public isOwner;                      // O(1) access-control check
uint256 public required;                                      // threshold M
Transaction[] private transactions;                           // txId = array index
mapping(uint256 => mapping(address => bool)) public isConfirmed; // txId => owner => approved
```

The confirmation count is **not stored**; `getConfirmationCount(txId)` counts the
current owners who have confirmed. This is what makes removed owners'
confirmations stop counting automatically (see §5).

### Transaction lifecycle

```
               submitTransaction()            confirmTransaction()
  owner ─────────────────────────▶ PENDING ◀──────────────────────── owners
                                    │   ▲
             revokeConfirmation()   │   │  (confirmations < required:
                    ◀───────────────┘   │   executeTransaction() reverts
                                        │   with NotEnoughConfirmations)
                                        │
            confirmations ≥ required    ▼
  any owner ── executeTransaction() ──▶ EXECUTED  (final: cannot be confirmed,
                                                   revoked or executed again)

  If the external call fails, executeTransaction() reverts as a whole:
  the transaction stays PENDING and can be executed again later.
```

### Functions

| Function | Who | What it does |
|---|---|---|
| `constructor(owners, required)` | deployer | Sets owners and threshold; rejects zero/duplicate owners and invalid thresholds |
| `receive()` | anyone | Accepts Ether, emits `Deposit` |
| `submitTransaction(to, value, data)` | owner | Stores a new pending transaction, returns its `txId` |
| `confirmTransaction(txId)` | owner | Approves a pending transaction (once per owner) |
| `revokeConfirmation(txId)` | owner | Withdraws your own approval before execution |
| `executeTransaction(txId)` | owner | Executes if confirmations ≥ `required` |
| `addOwner(owner)` | wallet only | Adds an owner |
| `removeOwner(owner)` | wallet only | Removes an owner (if the rest can still reach the threshold) |
| `replaceOwner(old, new)` | wallet only | Swaps an owner, e.g. after a lost key |
| `changeRequirement(required)` | wallet only | Changes the threshold |
| `getOwners()`, `getTransactionCount()`, `getTransaction(txId)`, `getConfirmationCount(txId)`, `getConfirmations(txId)`, `isExecutable(txId)` | anyone | Read-only views |

### Events

| Event | Emitted when |
|---|---|
| `Deposit(sender, amount, balance)` | Ether is received |
| `SubmitTransaction(owner, txId, to, value, data)` | A transaction is proposed |
| `ConfirmTransaction(owner, txId)` | An owner confirms |
| `RevokeConfirmation(owner, txId)` | An owner revokes |
| `ExecuteTransaction(owner, txId)` | A transaction is executed |
| `OwnerAdded(owner)`, `OwnerRemoved(owner)`, `RequirementChanged(required)` | The owner set or threshold changes (also at deployment) |

### Errors

Custom errors carry the values that caused the failure, so a revert is easy to
understand and cheap in gas: `NotOwner(caller)`, `OnlyWallet()`,
`TxDoesNotExist(txId)`, `TxAlreadyExecuted(txId)`,
`TxAlreadyConfirmed(txId, owner)`, `TxNotConfirmed(txId, owner)`,
`NotEnoughConfirmations(txId, confirmations, required)`,
`ExecutionFailed(txId, returnData)`, `InsufficientBalance(balance, needed)`,
`InvalidDestination()`, `InvalidOwner(owner)`, `DuplicateOwner(owner)`,
`InvalidRequirement(ownerCount, required)`.

`ExecutionFailed` includes the **inner** revert data of the failed call, so the
real reason (e.g. `DuplicateOwner` from an owner-management call, or a token's
own error) is not lost.

---

## 4. How multi-signature approval is enforced

1. **Only owners take part.** `onlyOwner` (a single `isOwner` lookup) guards
   submit, confirm, revoke and execute. Everyone else is rejected with `NotOwner`.
2. **One vote per owner.** `isConfirmed[txId][owner]` is a boolean; confirming
   twice reverts with `TxAlreadyConfirmed`, so one owner cannot fill the
   threshold alone.
3. **The threshold is checked at execution.** `executeTransaction` counts the
   confirmations of current owners and reverts with `NotEnoughConfirmations`
   below `required`. There is no other path that moves funds.
4. **Each transaction runs once.** `executed` is set before the external call;
   any later confirm, revoke or execute reverts with `TxAlreadyExecuted`.
5. **The rules themselves need M-of-N.** Owner management functions are
   `onlyWallet`: the only caller that passes is the wallet itself, which happens
   only when an approved transaction with `to = wallet` is executed. No owner,
   not even the deployer, has special powers.

---

## 5. Security considerations

| Risk | How it is addressed |
|---|---|
| **Reentrancy** during execution (the recipient calls back into the wallet) | Checks-effects-interactions: all checks, then `executed = true`, then the external call. Plus OpenZeppelin `nonReentrant` on `executeTransaction`, so a callback can execute neither the same transaction nor any other one. Both cases are tested with a malicious owner contract |
| **Double execution** | `executed` flag + `notExecuted` modifier |
| **Duplicate confirmations** | Per-owner boolean, `TxAlreadyConfirmed` |
| **Stale confirmations of a removed owner** | Confirmations are counted only for current owners, at execution time; tested |
| **Owner removal locking the wallet** | `removeOwner` reverts if fewer owners than `required` would remain; `changeRequirement` and the constructor enforce `1 ≤ required ≤ owners` |
| **Unauthorized rule changes** | `onlyWallet` on all owner-management functions |
| **Invalid owners** | Zero address, the wallet itself and duplicates are rejected |
| **Failed external call silently ignored** | The low-level `call` result is checked; on failure the whole execution reverts with `ExecutionFailed(txId, returnData)` and the transaction stays pending |
| **Funds sent to nowhere** | `to == address(0)` is rejected at submission |
| **Not enough Ether** | Explicit `InsufficientBalance` check before the call |
| **Gas limits / DoS through huge owner lists** | `MAX_OWNERS = 50` bounds every loop over owners |
| **Initialization takeover (Parity 2017)** | Owners are set in the constructor; there is no `initialize` function |
| **`delegatecall` / `selfdestruct` risks** | Not used; executed calls always run in the target's context |
| **Integer overflow** | Solidity 0.8 checked arithmetic |

### Known limitations

- **Approvals cost gas.** Each confirmation is a separate on-chain transaction.
  Safe avoids this with off-chain signatures, at the cost of more complex code.
- **No expiry.** A pending transaction stays valid until executed. Owners should
  revoke confirmations on proposals they no longer support.
- **Re-added owners.** If an owner is removed and later added back, confirmations
  they gave before removal count again. Revoke them first if that matters.
- **Order of execution is not enforced.** Transactions are independent; any
  approved one can be executed first.
- **The contract cannot verify intent.** As the Bybit case shows, owners must
  check `to`, `value` and decoded `data` before confirming.
- **Not audited.** This is a learning project; do not use it for real funds.

---

## 6. Deploying and interacting

### Setup

```bash
npm install
npx hardhat compile
npx hardhat test
npx hardhat coverage          # optional: coverage report
```

### Full lifecycle demo (local)

```bash
npx hardhat run scripts/demo.js
```

It deploys a 2-of-3 wallet with Alice, Bob and Carol, funds it, and walks
through submit → confirm → early execution (rejected) → confirm → revoke →
confirm → execute → second execution (rejected), then an ERC20 transfer and
adding a fourth owner by vote. The output is saved in
[`docs/demo-output.txt`](docs/demo-output.txt).

### Deploy locally

```bash
npx hardhat node                                        # terminal 1
npx hardhat run scripts/deploy.js --network localhost   # terminal 2
```

Without `OWNERS`, the first three local accounts become a 2-of-3 wallet.

### Deploy to Sepolia

```bash
npx hardhat vars set TESTNET_PRIVATE_KEY      # deployer's private key (test account)
```

PowerShell:

```powershell
$env:OWNERS="0xOwner1,0xOwner2,0xOwner3"
$env:REQUIRED="2"
npx hardhat run scripts/deploy.js --network testnet
```

macOS / Linux:

```bash
OWNERS=0xOwner1,0xOwner2,0xOwner3 REQUIRED=2 npx hardhat run scripts/deploy.js --network testnet
```

The deployer pays for deployment but does not have to be an owner.

### Interacting

From the Hardhat console (`npx hardhat console --network localhost`):

```js
const wallet = await ethers.getContractAt("MultiSigWallet", "0xWALLET");
const [a, b] = await ethers.getSigners();

// Ether transfer (fund the wallet first: send Ether to its address)
await wallet.connect(a).submitTransaction("0xRecipient", ethers.parseEther("0.1"), "0x");

// ERC20 transfer: `to` is the token, `data` is the encoded transfer call
const erc20 = new ethers.Interface(["function transfer(address,uint256)"]);
await wallet.connect(a).submitTransaction("0xToken", 0, erc20.encodeFunctionData("transfer", ["0xRecipient", 1000n]));

// Owner management: `to` is the wallet itself
await wallet.connect(a).submitTransaction(await wallet.getAddress(), 0,
  wallet.interface.encodeFunctionData("changeRequirement", [3]));

await wallet.connect(a).confirmTransaction(0);
await wallet.connect(b).confirmTransaction(0);
await wallet.isExecutable(0);            // true
await wallet.connect(a).executeTransaction(0);
```

On a testnet each owner can also work from the block explorer with MetaMask.
Verify the source first (needs a free Etherscan API key):

```bash
npx hardhat vars set ETHERSCAN_API_KEY
```

Create `arguments.js` with the same constructor arguments used for deployment:

```js
module.exports = [["0xOwner1", "0xOwner2", "0xOwner3"], 2];
```

```bash
npx hardhat verify --network testnet --constructor-args arguments.js 0xWALLET
```

Then on the contract page open **Contract → Write Contract → Connect to Web3**
and call `submitTransaction` (for a plain Ether transfer enter `0x` as `data`),
`confirmTransaction` and `executeTransaction`. The **Read Contract** tab shows
`getTransaction`, `getConfirmations` and `isExecutable`.

---

## 7. Testing

52 unit tests (Hardhat + Mocha/Chai, ethers v6). They check state changes,
emitted events with their arguments, and exact custom errors.

| Area | What is covered |
|---|---|
| Deployment (8) | owners/threshold stored; deployment events; empty owner list, threshold 0, threshold > owners, zero-address owner, duplicate owner, more than 50 owners |
| Deposits (1) | Ether from anyone, `Deposit` event, balance |
| Submission (5) | stored fields, event, no auto-confirm, increasing ids, non-owner rejected, zero destination rejected |
| Confirmation (5) | several owners confirm; **duplicate confirmation**; non-owner; non-existent tx; already executed tx |
| Revocation (7) | revoke and re-confirm; revoke without confirming; revoking another owner's vote; non-owner; after execution; revocation dropping below the threshold blocks execution |
| Execution (13) | Ether transfer at the threshold; 0 and 1 confirmations rejected; any owner may execute; non-owner rejected; **double execution**; non-existent tx; **ERC20 transfer via calldata**; failing call reverts with inner error and stays pending; insufficient balance; retry after top-up; 3-of-3; independent transactions |
| Reentrancy (2) | malicious owner contract re-entering the same transaction and another confirmed transaction; both blocked |
| Owner management (11) | direct calls rejected (`OnlyWallet`); add, remove, replace owner; **removed owner's confirmations stop counting**; removal that would break the threshold; invalid addresses; 50-owner cap; threshold change and invalid threshold |

Coverage of `MultiSigWallet.sol`: **100% statements, 100% functions, 100% lines,
96.9% branches**.

---

## 8. Reflection: the role of multi-sig wallets

Blockchains make transactions irreversible and remove intermediaries who could
undo a mistake or a theft. That makes **key management the main security
problem**: whoever holds the key holds the funds. A multi-sig turns this from
"trust one key" into "trust that at most M−1 of N keys are compromised or
dishonest at the same time", which is far more realistic for teams and
organizations.

In decentralized applications this has three effects. It **removes single points
of failure**: a lost laptop or one phished signer no longer means lost funds. It
**distributes power**: treasury spending, contract upgrades and parameter changes
need agreement, which is the basis of most DAO and protocol governance. And it
**adds transparency**: every proposal, approval and revocation is an on-chain
event that anyone can audit, as this contract's event log shows.

The incidents above also show the limits. A multi-sig is only as secure as its
code (Parity) and as careful as its signers (Bybit). Good practice is therefore
both technical and human: simple, tested contracts with no hidden admin powers;
signers on separate devices who verify exactly what they confirm; and a threshold
high enough to resist a few compromised keys but low enough that losing one key
does not freeze the wallet.

---

## Project structure

```
contracts/
  MultiSigWallet.sol            the wallet
  test/MockToken.sol            ERC20 used in tests and the demo
  test/Reverter.sol             target that always fails (failed-execution tests)
  test/ReentrancyAttacker.sol   malicious owner (reentrancy tests)
scripts/
  deploy.js                     deploy with OWNERS / REQUIRED
  demo.js                       full lifecycle walkthrough on a local network
test/
  MultiSigWallet.js             52 unit tests
docs/
  demo-output.txt               output of scripts/demo.js
hardhat.config.js
```

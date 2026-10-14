// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MultiSigWallet
/// @notice An M-of-N multi-signature wallet. Any owner can propose a transaction
///         (an Ether transfer or any contract call, e.g. an ERC20 transfer),
///         owners confirm it, and once `required` current owners have confirmed,
///         any owner can execute it. A confirmation can be revoked until execution.
/// @dev Design choices:
///      - Owner management (add / remove / replace / change threshold) can only be
///        done by the wallet itself, i.e. through a normal multi-sig transaction that
///        reaches the threshold. No single owner can change the rules alone.
///      - Confirmations are counted at execution time and only for *current* owners,
///        so a removed owner's old confirmations stop counting automatically.
///      - Execution follows checks-effects-interactions and is also `nonReentrant`.
contract MultiSigWallet is ReentrancyGuard {
    // ---------------------------------------------------------------------
    // Types and storage
    // ---------------------------------------------------------------------

    struct Transaction {
        address to; // destination: a wallet (Ether) or a contract (call)
        uint256 value; // wei to send
        bytes data; // calldata; empty for a plain Ether transfer
        bool executed; // set once, before the external call
    }

    /// @notice Upper bound on owners; keeps loops over `owners` cheap.
    uint256 public constant MAX_OWNERS = 50;

    address[] private owners;
    mapping(address => bool) public isOwner;
    uint256 public required;

    Transaction[] private transactions;
    /// @notice txId => owner => has confirmed
    mapping(uint256 => mapping(address => bool)) public isConfirmed;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Deposit(address indexed sender, uint256 amount, uint256 balance);
    event SubmitTransaction(
        address indexed owner,
        uint256 indexed txId,
        address indexed to,
        uint256 value,
        bytes data
    );
    event ConfirmTransaction(address indexed owner, uint256 indexed txId);
    event RevokeConfirmation(address indexed owner, uint256 indexed txId);
    event ExecuteTransaction(address indexed owner, uint256 indexed txId);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event RequirementChanged(uint256 required);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner(address caller);
    error OnlyWallet();
    error TxDoesNotExist(uint256 txId);
    error TxAlreadyExecuted(uint256 txId);
    error TxAlreadyConfirmed(uint256 txId, address owner);
    error TxNotConfirmed(uint256 txId, address owner);
    error NotEnoughConfirmations(uint256 txId, uint256 confirmations, uint256 required);
    error ExecutionFailed(uint256 txId, bytes returnData);
    error InvalidDestination();
    error InvalidOwner(address owner);
    error DuplicateOwner(address owner);
    error InvalidRequirement(uint256 ownerCount, uint256 required);
    error InsufficientBalance(uint256 balance, uint256 needed);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner(msg.sender);
        _;
    }

    /// @dev For owner management: callable only by the wallet via an executed transaction.
    modifier onlyWallet() {
        if (msg.sender != address(this)) revert OnlyWallet();
        _;
    }

    modifier txExists(uint256 txId) {
        if (txId >= transactions.length) revert TxDoesNotExist(txId);
        _;
    }

    modifier notExecuted(uint256 txId) {
        if (transactions[txId].executed) revert TxAlreadyExecuted(txId);
        _;
    }

    modifier validRequirement(uint256 ownerCount, uint256 _required) {
        if (ownerCount > MAX_OWNERS || _required == 0 || _required > ownerCount) {
            revert InvalidRequirement(ownerCount, _required);
        }
        _;
    }

    // ---------------------------------------------------------------------
    // Setup and deposits
    // ---------------------------------------------------------------------

    /// @param _owners initial owners (non-zero, no duplicates)
    /// @param _required confirmations needed to execute (1..owners.length)
    constructor(address[] memory _owners, uint256 _required)
        validRequirement(_owners.length, _required)
    {
        for (uint256 i = 0; i < _owners.length; i++) {
            address owner = _owners[i];
            if (owner == address(0)) revert InvalidOwner(owner);
            if (isOwner[owner]) revert DuplicateOwner(owner);
            isOwner[owner] = true;
            owners.push(owner);
            emit OwnerAdded(owner);
        }
        required = _required;
        emit RequirementChanged(_required);
    }

    /// @notice Anyone can fund the wallet with plain Ether.
    receive() external payable {
        emit Deposit(msg.sender, msg.value, address(this).balance);
    }

    // ---------------------------------------------------------------------
    // Transaction lifecycle: submit -> confirm (/ revoke) -> execute
    // ---------------------------------------------------------------------

    /// @notice Propose a transaction. Submitting does NOT confirm it automatically.
    /// @param to destination; for an ERC20 transfer this is the token contract
    /// @param value wei to send
    /// @param data calldata, e.g. abi.encodeCall(IERC20.transfer, (recipient, amount))
    /// @return txId index of the new transaction
    function submitTransaction(address to, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (uint256 txId)
    {
        if (to == address(0)) revert InvalidDestination();

        txId = transactions.length;
        transactions.push(Transaction({to: to, value: value, data: data, executed: false}));

        emit SubmitTransaction(msg.sender, txId, to, value, data);
    }

    /// @notice Approve a pending transaction.
    function confirmTransaction(uint256 txId)
        external
        onlyOwner
        txExists(txId)
        notExecuted(txId)
    {
        if (isConfirmed[txId][msg.sender]) revert TxAlreadyConfirmed(txId, msg.sender);

        isConfirmed[txId][msg.sender] = true;

        emit ConfirmTransaction(msg.sender, txId);
    }

    /// @notice Withdraw your own approval before the transaction is executed.
    function revokeConfirmation(uint256 txId)
        external
        onlyOwner
        txExists(txId)
        notExecuted(txId)
    {
        if (!isConfirmed[txId][msg.sender]) revert TxNotConfirmed(txId, msg.sender);

        isConfirmed[txId][msg.sender] = false;

        emit RevokeConfirmation(msg.sender, txId);
    }

    /// @notice Execute a transaction that has at least `required` confirmations
    ///         from current owners. Any owner may trigger it.
    /// @dev Checks-effects-interactions: `executed` is set before the external call.
    ///      If the call fails, the whole execution reverts, `executed` returns to
    ///      false, and the transaction can be retried later.
    function executeTransaction(uint256 txId)
        external
        onlyOwner
        txExists(txId)
        notExecuted(txId)
        nonReentrant
    {
        Transaction storage txn = transactions[txId];

        // Checks
        uint256 confirmations = getConfirmationCount(txId);
        if (confirmations < required) {
            revert NotEnoughConfirmations(txId, confirmations, required);
        }
        if (address(this).balance < txn.value) {
            revert InsufficientBalance(address(this).balance, txn.value);
        }

        // Effects
        txn.executed = true;

        // Interactions
        (bool success, bytes memory returnData) = txn.to.call{value: txn.value}(txn.data);
        if (!success) revert ExecutionFailed(txId, returnData);

        emit ExecuteTransaction(msg.sender, txId);
    }

    // ---------------------------------------------------------------------
    // Owner management (only through an executed multi-sig transaction)
    // ---------------------------------------------------------------------

    /// @notice Add a new owner. The threshold stays the same.
    function addOwner(address owner)
        external
        onlyWallet
        validRequirement(owners.length + 1, required)
    {
        if (owner == address(0) || owner == address(this)) revert InvalidOwner(owner);
        if (isOwner[owner]) revert DuplicateOwner(owner);

        isOwner[owner] = true;
        owners.push(owner);

        emit OwnerAdded(owner);
    }

    /// @notice Remove an owner. Reverts if the remaining owners could not reach
    ///         the threshold; lower the threshold first in that case.
    function removeOwner(address owner)
        external
        onlyWallet
        validRequirement(owners.length - 1, required)
    {
        if (!isOwner[owner]) revert InvalidOwner(owner);

        isOwner[owner] = false;
        uint256 last = owners.length - 1;
        for (uint256 i = 0; i <= last; i++) {
            if (owners[i] == owner) {
                owners[i] = owners[last];
                owners.pop();
                break;
            }
        }

        emit OwnerRemoved(owner);
    }

    /// @notice Swap one owner for another in a single step (e.g. a lost key).
    function replaceOwner(address owner, address newOwner) external onlyWallet {
        if (!isOwner[owner]) revert InvalidOwner(owner);
        if (newOwner == address(0) || newOwner == address(this)) revert InvalidOwner(newOwner);
        if (isOwner[newOwner]) revert DuplicateOwner(newOwner);

        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == owner) {
                owners[i] = newOwner;
                break;
            }
        }
        isOwner[owner] = false;
        isOwner[newOwner] = true;

        emit OwnerRemoved(owner);
        emit OwnerAdded(newOwner);
    }

    /// @notice Change how many confirmations are required.
    function changeRequirement(uint256 _required)
        external
        onlyWallet
        validRequirement(owners.length, _required)
    {
        required = _required;
        emit RequirementChanged(_required);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getTransactionCount() external view returns (uint256) {
        return transactions.length;
    }

    function getTransaction(uint256 txId)
        external
        view
        txExists(txId)
        returns (address to, uint256 value, bytes memory data, bool executed, uint256 numConfirmations)
    {
        Transaction storage txn = transactions[txId];
        return (txn.to, txn.value, txn.data, txn.executed, getConfirmationCount(txId));
    }

    /// @notice Confirmations from CURRENT owners only.
    function getConfirmationCount(uint256 txId) public view returns (uint256 count) {
        for (uint256 i = 0; i < owners.length; i++) {
            if (isConfirmed[txId][owners[i]]) count++;
        }
    }

    /// @notice Current owners who have confirmed `txId`.
    function getConfirmations(uint256 txId) external view returns (address[] memory confirmedBy) {
        address[] memory temp = new address[](owners.length);
        uint256 count;
        for (uint256 i = 0; i < owners.length; i++) {
            if (isConfirmed[txId][owners[i]]) temp[count++] = owners[i];
        }
        confirmedBy = new address[](count);
        for (uint256 i = 0; i < count; i++) confirmedBy[i] = temp[i];
    }

    function isExecutable(uint256 txId) external view returns (bool) {
        if (txId >= transactions.length || transactions[txId].executed) return false;
        return getConfirmationCount(txId) >= required;
    }
}

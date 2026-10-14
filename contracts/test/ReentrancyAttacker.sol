// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMultiSig {
    function submitTransaction(address to, uint256 value, bytes calldata data) external returns (uint256);
    function confirmTransaction(uint256 txId) external;
    function executeTransaction(uint256 txId) external;
}

/// @dev Test-only malicious owner. When it receives Ether from the wallet it tries
///      to re-enter executeTransaction (the same or another confirmed transaction).
///      It swallows the error so the outer transfer still succeeds, and records
///      whether the re-entry worked.
contract ReentrancyAttacker {
    IMultiSig public immutable wallet;
    uint256 public targetTxId;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(address _wallet) {
        wallet = IMultiSig(_wallet);
    }

    function setTarget(uint256 txId) external {
        targetTxId = txId;
    }

    function submit(address to, uint256 value, bytes calldata data) external returns (uint256) {
        return wallet.submitTransaction(to, value, data);
    }

    function confirm(uint256 txId) external {
        wallet.confirmTransaction(txId);
    }

    receive() external payable {
        if (reentryAttempted) return;
        reentryAttempted = true;
        try wallet.executeTransaction(targetTxId) {
            reentrySucceeded = true;
        } catch {
            reentrySucceeded = false;
        }
    }
}

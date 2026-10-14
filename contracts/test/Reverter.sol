// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Test-only target that always fails, to test failed executions.
contract Reverter {
    error AlwaysFails();

    receive() external payable {
        revert AlwaysFails();
    }

    fallback() external payable {
        revert AlwaysFails();
    }
}

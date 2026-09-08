// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice LayerZero V2 `Origin` struct. Field names/order/layout MUST match
///         `@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol`
///         exactly — the endpoint ABI-encodes this tuple when it calls a receiver,
///         so the compiled selector depends on this layout:
///         `lzReceive((uint32,bytes32,uint64),bytes32,bytes,address,bytes)`.
/// @dev    Kept local (no @layerzerolabs import) so the toy `v3-crosschain/base`
///         Hardhat project needs no extra npm dependency beyond hardhat-toolbox.
struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

/// @notice Minimal LayerZero V2 receiver interface — the exact surface the
///         Foundation boilerplate's own `BridgeReceiver.sol` implements
///         (`allowInitializePath` + `nextNonce` + `lzReceive`). No
///         `isComposeReceiver` is needed because the v3 relay never attaches a
///         compose payload (`Options.addExecutorLzReceiveOption(...)` only).
interface ILayerZeroReceiver {
    function allowInitializePath(Origin calldata _origin) external view returns (bool);

    function nextNonce(uint32 _eid, bytes32 _sender) external view returns (uint64);

    function lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) external payable;
}

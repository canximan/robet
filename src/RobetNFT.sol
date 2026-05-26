// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721}  from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title RobetNFT
/// @notice Membership NFT for Robet. Holders bypass the per-bet entry fee in BetPool.
///
/// Non-upgradeable. Supply hard-capped at MAX_SUPPLY. The Staking contract is
/// the sole minter (set via setMinter() after deploy and before ownership is
/// handed to the cold wallet).
///
/// Marketplace metadata
/// ────────────────────
///   ERC721Metadata: name() = "Robet Member", symbol() = "ROBET".
///   tokenURI(id)           = _baseURI() + id           (per-token JSON)
///   contractURI()          = collection-level JSON     (OpenSea / Ronin convention)
///
///   Both URIs are mutable via setBaseURI / setContractURI (owner-only) so the
///   metadata host can be moved (e.g. arweave → IPFS) without redeploying.
contract RobetNFT is ERC721, Ownable {

    /// @notice Hard cap on total NFTs.
    uint256 public constant MAX_SUPPLY = 33_000;

    /// @notice Sequential token id counter; next mint uses this value.
    uint256 public totalSupply;

    /// @notice Sole address permitted to mint. Set by the owner via setMinter().
    address public minter;

    // Per-token metadata base. tokenURI(id) = baseURI + id.toString().
    // The metadata server must serve a JSON document at that URL.
    string private _baseTokenURI;

    // Collection-level metadata for marketplace listings (name, description,
    // banner image, royalty config, etc.).
    string private _contractURI;

    event MinterUpdated     (address indexed previousMinter, address indexed newMinter);
    event BaseURIUpdated    (string newBaseURI);
    event ContractURIUpdated(string newContractURI);

    constructor(
        address initialOwner,
        string memory baseURI_,
        string memory contractURI_
    )
        ERC721("Robet Member", "ROBET")
        Ownable(initialOwner)
    {
        _baseTokenURI = baseURI_;
        _contractURI  = contractURI_;
    }

    // ── Minter management ────────────────────────────────────────────────────

    /// @notice Set the (sole) address allowed to mint. Owner only.
    function setMinter(address _minter) external onlyOwner {
        emit MinterUpdated(minter, _minter);
        minter = _minter;
    }

    // ── Metadata ─────────────────────────────────────────────────────────────

    /// @notice Update the per-token metadata base URL. Owner only.
    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _baseTokenURI = baseURI_;
        emit BaseURIUpdated(baseURI_);
    }

    /// @notice Update the collection-level metadata URL. Owner only.
    function setContractURI(string calldata contractURI_) external onlyOwner {
        _contractURI = contractURI_;
        emit ContractURIUpdated(contractURI_);
    }

    /// @notice Used by the default ERC721 tokenURI(id) implementation.
    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    /// @notice Collection metadata URL. Marketplaces (OpenSea, Ronin) read this
    ///         to display the collection's name, description, image, and
    ///         optional royalty info.
    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    // ── Mint ─────────────────────────────────────────────────────────────────

    /// @notice Mint exactly one NFT to `to`. Callable only by the configured minter.
    function mint(address to) external returns (uint256 tokenId) {
        require(msg.sender == minter, "only minter");
        require(totalSupply < MAX_SUPPLY, "max supply reached");
        tokenId = totalSupply;
        unchecked { totalSupply++; }
        _mint(to, tokenId);
    }
}

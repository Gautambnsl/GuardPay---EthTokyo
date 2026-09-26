// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title InvoiceToken
/// @notice Tokenized supplier invoices. Each NFT is one invoice owned by its supplier.
///         The treasury agent marks an invoice paid once its x402 USDC payment settles.
contract InvoiceToken is ERC721, Ownable {
    struct Invoice {
        address supplier; // payee for the x402 payment
        uint256 amount; // USDC, 6 decimals
        uint64 dueDate; // unix seconds
        bool paid;
        bytes32 paymentRef; // settlement tx hash of the x402 payment
    }

    uint256 public nextId = 1;
    address public agent;
    mapping(uint256 => Invoice) private _invoices;

    event InvoiceIssued(uint256 indexed id, address indexed supplier, uint256 amount, uint64 dueDate);
    event InvoicePaid(uint256 indexed id, bytes32 paymentRef);
    event AgentUpdated(address indexed agent);

    error NotAgent();
    error AlreadyPaid(uint256 id);
    error UnknownInvoice(uint256 id);

    constructor(address initialOwner, address initialAgent) ERC721("GuardPay Invoice", "GPINV") Ownable(initialOwner) {
        agent = initialAgent;
        emit AgentUpdated(initialAgent);
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    function setAgent(address newAgent) external onlyOwner {
        agent = newAgent;
        emit AgentUpdated(newAgent);
    }

    /// @notice Issue an invoice NFT to `supplier`.
    function issue(address supplier, uint256 amount, uint64 dueDate) external onlyOwner returns (uint256 id) {
        id = nextId++;
        _invoices[id] = Invoice({supplier: supplier, amount: amount, dueDate: dueDate, paid: false, paymentRef: 0});
        _safeMint(supplier, id);
        emit InvoiceIssued(id, supplier, amount, dueDate);
    }

    /// @notice Called by the treasury agent after the x402 payment settled.
    function markPaid(uint256 id, bytes32 paymentRef) external onlyAgent {
        Invoice storage inv = _invoices[id];
        if (inv.supplier == address(0)) revert UnknownInvoice(id);
        if (inv.paid) revert AlreadyPaid(id);
        inv.paid = true;
        inv.paymentRef = paymentRef;
        emit InvoicePaid(id, paymentRef);
    }

    function getInvoice(uint256 id) external view returns (Invoice memory inv) {
        inv = _invoices[id];
        if (inv.supplier == address(0)) revert UnknownInvoice(id);
    }
}

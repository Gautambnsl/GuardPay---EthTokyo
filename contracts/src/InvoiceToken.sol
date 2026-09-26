// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title InvoiceToken
/// @notice Tokenized supplier invoices (receivables). A supplier issues an invoice to a payer and
///         receives the NFT: whoever holds it owns the right to be paid, so it can be held or sold.
///         The payer's treasury agent watches InvoiceIssued, pays over x402, then marks it paid.
contract InvoiceToken is ERC721 {
    struct Invoice {
        address issuer; // supplier that issued the invoice (initial NFT holder)
        address payer; // company that owes the money; only its agent can mark it paid
        address payTo; // where the x402 USDC payment must go
        uint256 amount; // USDC, 6 decimals
        uint64 dueDate; // unix seconds
        bool paid;
        bytes32 paymentRef; // settlement tx hash of the x402 payment
    }

    uint256 public nextId = 1;
    mapping(uint256 => Invoice) private _invoices;

    event InvoiceIssued(
        uint256 indexed id, address indexed issuer, address indexed payer, address payTo, uint256 amount, uint64 dueDate
    );
    event InvoicePaid(uint256 indexed id, address indexed payer, bytes32 paymentRef);

    error NotPayer();
    error AlreadyPaid(uint256 id);
    error UnknownInvoice(uint256 id);
    error InvalidInvoice();

    constructor() ERC721("GuardPay Invoice", "GPINV") {}

    /// @notice Supplier issues an invoice to `payer`; the invoice NFT is minted to the supplier.
    function issue(address payer, address payTo, uint256 amount, uint64 dueDate) external returns (uint256 id) {
        if (payer == address(0) || payTo == address(0) || amount == 0) revert InvalidInvoice();
        id = nextId++;
        _invoices[id] = Invoice({
            issuer: msg.sender,
            payer: payer,
            payTo: payTo,
            amount: amount,
            dueDate: dueDate,
            paid: false,
            paymentRef: 0
        });
        _safeMint(msg.sender, id);
        emit InvoiceIssued(id, msg.sender, payer, payTo, amount, dueDate);
    }

    /// @notice Called by the payer's treasury agent after the x402 payment settled.
    function markPaid(uint256 id, bytes32 paymentRef) external {
        Invoice storage inv = _invoices[id];
        if (inv.issuer == address(0)) revert UnknownInvoice(id);
        if (msg.sender != inv.payer) revert NotPayer();
        if (inv.paid) revert AlreadyPaid(id);
        inv.paid = true;
        inv.paymentRef = paymentRef;
        emit InvoicePaid(id, msg.sender, paymentRef);
    }

    function getInvoice(uint256 id) external view returns (Invoice memory inv) {
        inv = _invoices[id];
        if (inv.issuer == address(0)) revert UnknownInvoice(id);
    }
}

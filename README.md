# Digital Banking Server — Backend REST API

High-performance, secure, and production-ready Express + TypeScript backend server for the **Advanced Digital Banking Management System**.

---

## 🏛️ Project Overview

The backend simulates a modern enterprise financial platform with atomic fund transfers, role-based access control (Admin, Bank Staff, Customer), regulatory limits, real-time analytics aggregations, transaction consistency, and automated/manual review pipelines.

- **Platform:** Node.js + Express (TypeScript)
- **Database:** MongoDB Atlas (native driver with connection pooling & optional replica set transactions)
- **Security:** Helmet, CORS with strict whitelisting, Rate Limiting (global & brute-force auth limiters), Bcrypt salt hashing, JWT bearer tokens.
- **Performance:** Lazy loading of sub-routers and dynamic modules for rapid startup and low memory footprint.

---

## 👥 User Roles & Permissions

| Role | Permissions & Scope |
|---|---|
| **Admin** | Full system overview, platform analytics, customer management (status/block), bank account management & transaction limits, loan approvals/rejections with automatic disbursement, review flagged transactions. |
| **Bank Staff** | Customer onboarding, customer bank account creation, customer KYC verification, view transactions, flag suspicious transactions, loan review and note submission, forward applications to Admin. |
| **Customer** | Multi-account management, atomic internal/in-bank fund transfers, submit deposit/withdrawal requests, loan application & EMI repayment, CSV statement generation, transaction receipts, notifications. |

---

## 🔑 Demo Credentials

| Role | Email | Password | Transaction PIN / Notes |
|---|---|---|---|
| **Admin** | `admin@vaultly.bank` | `Admin@1234` | Full access to Admin portal |
| **Bank Staff** | `staff@vaultly.bank` | `Staff@1234` | Employee ID: `EMP-4092` |
| **Customer** | `customer@vaultly.bank` | `Customer@1234` | PIN: `1234` (Accounts: `1008492041`, `1009841205`) |
| **Customer (Elena)** | `elena.rostova@vaultly.bank` | `Elena@1234` | PIN: `5678` (Account: `1003489112`) |

---

## 🛠️ API Endpoints Summary

### 1. Authentication (`/api/auth`)
- `POST /api/auth/register` — Register a new Customer account
- `POST /api/auth/login` — Sign in and retrieve JWT Bearer token
- `GET /api/auth/me` — Retrieve authenticated user profile

### 2. Customer Routes (`/api/customer`) — Requires `Bearer <JWT>` & Role: `Customer`
- **Accounts:**
  - `GET /api/customer/accounts` — List customer bank accounts (auto-creates default Savings if empty)
  - `POST /api/customer/accounts` — Open additional account (Savings, Current, Business)
  - `GET /api/customer/accounts/:accountNumber` — View single account details & limits
- **Fund Transfer:**
  - `POST /api/customer/transfer` — Atomic fund transfer (PIN verification, balance validation, limit checks, suspicious detection, notifications)
- **Transactions:**
  - `GET /api/customer/transactions` — Paginated transaction history (search, filter by account, type, status, and dates)
  - `GET /api/customer/transactions/:txnId` — Single transaction cryptographic detail
- **Deposit & Withdrawal:**
  - `GET /api/customer/deposit-withdraw` — List deposit/withdrawal requests
  - `POST /api/customer/deposit-withdraw` — Submit request (instant clearance for <= $500, review for > $500)
  - `GET /api/customer/deposit-withdraw/:requestId` — Request detail
- **Loans & EMI:**
  - `GET /api/customer/loans` — View all customer loans
  - `POST /api/customer/loans` — Apply for loan (instant micro-disbursement <= $1,000, review for > $1,000)
  - `GET /api/customer/loans/:loanId` — Loan details & repayment history
  - `POST /api/customer/loans/:loanId/repay` — Repay installment directly from bank account balance
- **Statement & Notifications:**
  - `GET /api/customer/statement` — Export account transaction statement as RFC 4180 CSV
  - `GET /api/customer/notifications` — Retrieve customer alerts
  - `PATCH /api/customer/notifications/:id/read` — Mark notification read
  - `PATCH /api/customer/notifications/read-all` — Mark all read
- **Profile:**
  - `GET /api/customer/profile` — View profile
  - `PATCH /api/customer/profile` — Update contact information
  - `PATCH /api/customer/profile/change-pin` — Change 4-digit transaction PIN
  - `PATCH /api/customer/profile/change-password` — Change password

### 3. Bank Staff Routes (`/api/staff`) — Requires Role: `Bank Staff` or `Admin`
- `GET /api/staff/customers` — List & search customers
- `GET /api/staff/customers/:email` — View customer information & accounts
- `POST /api/staff/customers` — Register customer
- `PATCH /api/staff/customers/:email/verify` — Verify customer KYC
- `POST /api/staff/accounts` — Open account on behalf of customer
- `GET /api/staff/transactions` — View, filter, and search transactions
- `PATCH /api/staff/transactions/:txnId/flag` — Flag suspicious transactions for Admin review
- `GET /api/staff/loans` — View loan applications
- `PATCH /api/staff/loans/:loanId/note` — Add internal staff evaluation note
- `PATCH /api/staff/loans/:loanId/forward` — Forward loan application to Admin for final approval

### 4. Admin Routes (`/api/admin`) — Requires Role: `Admin`
- `GET /api/admin/dashboard` — Platform financial totals (Customers, Accounts, Balance, Deposits, Withdrawals, Loans)
- `GET /api/admin/analytics` — MongoDB aggregations for charts (6-month trends, distribution, loan statistics)
- `GET /api/admin/customers` — View & search all customers
- `GET /api/admin/customers/:email` — Detailed customer portfolio
- `GET /api/admin/customers/:email/transactions` — Specific customer transaction trail
- `PATCH /api/admin/customers/:email/status` — Activate, suspend, or block customer (cascades to accounts)
- `GET /api/admin/accounts` — View & search all accounts
- `POST /api/admin/accounts` — Directly provision new bank accounts with initial deposit
- `PATCH /api/admin/accounts/:accountNumber` — Update limits (`dailyLimit`, `maxSingleTransaction`, `minBalance`) or freeze/unfreeze
- `GET /api/admin/transactions` — All transactions with date, type, status, and suspicious filters
- `PATCH /api/admin/transactions/:txnId/review` — Resolve flagged transactions (Dismiss or Reverse transfer)
- `GET /api/admin/loans` — View loan applications
- `PATCH /api/admin/loans/:loanId` — Approve (triggers recorded disbursement transaction) or Reject
- `GET /api/admin/requests` — View deposit/withdrawal requests
- `PATCH /api/admin/requests/:requestId` — Approve or reject requests
- `GET /api/admin/staff` — List staff members
- `POST /api/admin/staff` — Onboard new bank staff

---

## 🔒 Security & Data Integrity

1. **Server-Side Validation:** Account ownership, minimum balance reserves, single transaction caps, and daily cumulative caps are validated exclusively on the server before mutating state.
2. **Atomic Transfers:** Multi-document updates ensure sender deduction and recipient credit never leave funds in an inconsistent state.
3. **Transaction PIN Validation:** Transacting requires matching the hashed 4-digit PIN using Bcrypt.
4. **Rule-Based Suspicious Detection:** Transfers >= $10,000 or exceeding 80% of daily limit are automatically flagged for Admin security review.
5. **Rate Limiting:** Global rate limiting (500 req/15min) and strict authentication rate limiting (20 req/15min) prevent brute-force attacks.

---

## ⚙️ Environment Variables

Create `.env` in `digital-banking-server`:

```env
PORT=5000
MONGODB_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/?retryWrites=true&w=majority
DB_NAME=digital_banking
JWT_SECRET=your_super_secret_jwt_key
JWT_EXPIRES_IN=7d
CLIENT_URL=http://localhost:3000
```

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Seed Demo Database
```bash
npm run seed
```

### 3. Build & Run
```bash
# Development mode with hot-reload
npm run dev

# Production build & start
npm run build
npm start
```
Server runs at `http://localhost:5000`. Health check: `http://localhost:5000/api/health`.

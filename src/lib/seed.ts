import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { connectDB } from './db';

async function seed() {
  console.log('🌱 Seeding database...');
  const db = await connectDB();

  const usersCol = db.collection('users');
  const bankAccountsCol = db.collection('bank_accounts');
  const transactionsCol = db.collection('transactions');
  const loansCol = db.collection('loans');

  // 1. Admin
  if (!(await usersCol.findOne({ email: 'admin@vaultly.bank' }))) {
    await usersCol.insertOne({
      name: 'System Admin',
      email: 'admin@vaultly.bank',
      password: await bcrypt.hash('Admin@1234', 10),
      role: 'Admin',
      status: 'Active',
      phone: '+1 (555) 100-0001',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('  ✅ Admin created');
  }

  // 2. Bank Staff
  if (!(await usersCol.findOne({ email: 'staff@vaultly.bank' }))) {
    await usersCol.insertOne({
      name: 'Sarah Jenkins',
      email: 'staff@vaultly.bank',
      password: await bcrypt.hash('Staff@1234', 10),
      role: 'Bank Staff',
      status: 'Active',
      employeeId: 'EMP-4092',
      branchCode: 'VLT-NYC-01',
      phone: '+1 (555) 200-4092',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('  ✅ Staff created');
  }

  // 3. Customer: Alexander Vance
  let customerUserId: string | null = null;
  const existingCustomer = await usersCol.findOne({ email: 'customer@vaultly.bank' });
  if (!existingCustomer) {
    const result = await usersCol.insertOne({
      name: 'Alexander Vance',
      email: 'customer@vaultly.bank',
      password: await bcrypt.hash('Customer@1234', 10),
      transactionPin: await bcrypt.hash('1234', 10),
      role: 'Customer',
      status: 'Active',
      phone: '+1 (555) 234-5678',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    customerUserId = result.insertedId.toString();
    console.log('  ✅ Customer created');
  } else {
    customerUserId = existingCustomer._id.toString();
  }

  // 4. Primary Savings Account
  if (!(await bankAccountsCol.findOne({ accountNumber: '1008492041' })) && customerUserId) {
    await bankAccountsCol.insertOne({
      userId: customerUserId,
      userEmail: 'customer@vaultly.bank',
      userName: 'Alexander Vance',
      accountNumber: '1008492041',
      accountType: 'Savings Account',
      balance: 25480.0,
      status: 'Active',
      dailyLimit: 10000,
      maxSingleTransaction: 5000,
      minBalance: 100,
      createdAt: new Date(Date.now() - 60 * 24 * 3600 * 1000),
      updatedAt: new Date(),
    });
    console.log('  ✅ Primary savings account created');
  }

  // 5. Secondary Business Account
  if (!(await bankAccountsCol.findOne({ accountNumber: '1009841205' })) && customerUserId) {
    await bankAccountsCol.insertOne({
      userId: customerUserId,
      userEmail: 'customer@vaultly.bank',
      userName: 'Alexander Vance',
      accountNumber: '1009841205',
      accountType: 'Business Account',
      balance: 14250.0,
      status: 'Active',
      dailyLimit: 25000,
      maxSingleTransaction: 10000,
      minBalance: 500,
      createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
      updatedAt: new Date(),
    });
    console.log('  ✅ Business account created');
  }

  // 6. Sample Recipient: Elena Rostova
  if (!(await usersCol.findOne({ email: 'elena.rostova@vaultly.bank' }))) {
    const recipient = await usersCol.insertOne({
      name: 'Elena Rostova',
      email: 'elena.rostova@vaultly.bank',
      password: await bcrypt.hash('Elena@1234', 10),
      transactionPin: await bcrypt.hash('5678', 10),
      role: 'Customer',
      status: 'Active',
      phone: '+1 (555) 987-6543',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await bankAccountsCol.insertOne({
      userId: recipient.insertedId.toString(),
      userEmail: 'elena.rostova@vaultly.bank',
      userName: 'Elena Rostova',
      accountNumber: '1003489112',
      accountType: 'Current Account',
      balance: 8900.0,
      status: 'Active',
      dailyLimit: 5000,
      maxSingleTransaction: 2000,
      minBalance: 50,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('  ✅ Recipient Elena Rostova created');
  }

  // 7. Sample Transactions
  const txnCount = await transactionsCol.countDocuments({
    $or: [
      { senderEmail: 'customer@vaultly.bank' },
      { receiverEmail: 'customer@vaultly.bank' },
    ],
  });
  if (txnCount === 0) {
    const now = Date.now();
    await transactionsCol.insertMany([
      {
        transactionId: 'TXN-8F92A14B',
        senderAccount: 'SYSTEM', senderName: 'Vaultly Payroll Systems', senderEmail: 'payroll@vaultly.bank',
        receiverAccount: '1008492041', receiverName: 'Alexander Vance', receiverEmail: 'customer@vaultly.bank',
        type: 'Deposit', amount: 5400.0, fee: 0, status: 'Completed',
        description: 'Monthly Salary Direct Deposit',
        createdAt: new Date(now - 3 * 24 * 3600 * 1000), updatedAt: new Date(now - 3 * 24 * 3600 * 1000),
      },
      {
        transactionId: 'TXN-4B11E99A',
        senderAccount: '1008492041', senderName: 'Alexander Vance', senderEmail: 'customer@vaultly.bank',
        receiverAccount: '1003489112', receiverName: 'Elena Rostova', receiverEmail: 'elena.rostova@vaultly.bank',
        type: 'Transfer', amount: 850.0, fee: 0, status: 'Completed',
        description: 'Office Co-working Space Share',
        createdAt: new Date(now - 6 * 24 * 3600 * 1000), updatedAt: new Date(now - 6 * 24 * 3600 * 1000),
      },
      {
        transactionId: 'TXN-7A23C88D',
        senderAccount: '1008492041', senderName: 'Alexander Vance', senderEmail: 'customer@vaultly.bank',
        receiverAccount: 'ATM-VLT-04', receiverName: 'ATM Cash Withdrawal', receiverEmail: 'atm@vaultly.bank',
        type: 'Withdrawal', amount: 400.0, fee: 0, status: 'Completed',
        description: 'Cash Withdrawal at Metro ATM #4',
        createdAt: new Date(now - 10 * 24 * 3600 * 1000), updatedAt: new Date(now - 10 * 24 * 3600 * 1000),
      },
    ]);
    console.log('  ✅ Sample transactions created');
  }

  // 8. Sample Loan
  if (!(await loansCol.findOne({ userEmail: 'customer@vaultly.bank' })) && customerUserId) {
    await loansCol.insertOne({
      loanId: 'LN-40291',
      userId: customerUserId,
      userEmail: 'customer@vaultly.bank',
      userName: 'Alexander Vance',
      accountNumber: '1008492041',
      loanType: 'Personal Loan',
      requestedAmount: 12000.0,
      interestRate: 5.5,
      durationMonths: 24,
      monthlyInstallment: 529.18,
      monthlyIncome: 7500.0,
      employmentStatus: 'Employed',
      description: 'Home Office Renovation & Modernization',
      status: 'Active',
      remainingBalance: 9525.26,
      paidAmount: 3175.08,
      repayments: [],
      approvedAt: new Date(Date.now() - 75 * 24 * 3600 * 1000),
      disbursedAt: new Date(Date.now() - 75 * 24 * 3600 * 1000),
      createdAt: new Date(Date.now() - 75 * 24 * 3600 * 1000),
      updatedAt: new Date(),
    });
    console.log('  ✅ Sample loan created');
  }

  console.log('\n🎉 Seeding complete!');
  console.log('Demo Credentials:');
  console.log('  Admin:    admin@vaultly.bank    / Admin@1234');
  console.log('  Staff:    staff@vaultly.bank    / Staff@1234');
  console.log('  Customer: customer@vaultly.bank / Customer@1234 (PIN: 1234)');
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
});

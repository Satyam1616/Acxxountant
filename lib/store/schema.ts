import { z } from "zod";
import { isSupportedCurrency } from "@/lib/domain/currency";
export type StoredMoney = { currency: string; minor: string };
export type StoredJournalLine = {
  id: string;
  accountId: string;
  side: "debit" | "credit";
  amount: StoredMoney;
  memo?: string;
};
export type StoredJournalEntry = {
  id: string;
  entityId: string;
  date: string;
  description: string;
  source:
    | "invoice"
    | "credit-note"
    | "payable-invoice"
    | "payable-credit-note"
    | "bank-reconciliation"
    | "manual"
    | "fx-revaluation"
    | "reversal"
    | "opening";
  sourceId: string;
  lines: StoredJournalLine[];
  createdAt: string;
  reversedBy?: string;
  reverses?: string;
};
export type StoredInvoiceLine = {
  id: string;
  description: string;
  quantity: number;
  unitMinor: string;
  accountId: string;
};
export type StoredInvoice = Omit<import("@/lib/domain/types").Invoice, "lines" | "total"> & {
  lines: StoredInvoiceLine[];
  total: StoredMoney;
};
export type StoredTransaction = Omit<import("@/lib/domain/types").BankTransaction, "amount"> & {
  amount: StoredMoney;
};
export type StoredMatch = Omit<import("@/lib/domain/types").PaymentMatch, "allocations"> & {
  allocations: Array<{ invoiceId: string; amount: StoredMoney }>;
};

const currencySchema = z.string().refine(isSupportedCurrency, "Unsupported currency");

const moneySchema = z.object({
  currency: currencySchema,
  minor: z.string().regex(/^-?\d+$/),
});

const accountSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["asset", "liability", "equity", "income", "expense"]),
  control: z.enum(["bank", "receivable", "payable", "unapplied"]).nullable(),
  currency: currencySchema.nullable(),
  active: z.boolean(),
});

const settingsSchema = z.object({
  autoApplyThreshold: z.number().finite().min(0).max(1),
  feeToleranceMinor: z.string().regex(/^\d+$/),
  defaultCurrency: currencySchema,
  aiProvider: z.enum(["rules", "groq", "claude"]),
});

const lineSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  side: z.enum(["debit", "credit"]),
  amount: moneySchema,
  memo: z.string().optional(),
});

const journalSchema = z.object({
  id: z.string().min(1),
  entityId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string(),
  source: z.enum([
    "invoice",
    "credit-note",
    "payable-invoice",
    "payable-credit-note",
    "bank-reconciliation",
    "manual",
    "fx-revaluation",
    "reversal",
    "opening",
  ]),
  sourceId: z.string().min(1),
  lines: z.array(lineSchema).min(2),
  createdAt: z.string().datetime(),
  reversedBy: z.string().optional(),
  reverses: z.string().optional(),
});

const invoiceSchema = z.object({
  id: z.string().min(1),
  entityId: z.string().min(1),
  customerId: z.string().min(1),
  number: z.string().min(1),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: currencySchema,
  lines: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string(),
      quantity: z.number().int().positive(),
      unitMinor: z.string().regex(/^\d+$/),
      accountId: z.string().min(1),
    }),
  ),
  total: moneySchema,
  status: z.enum(["draft", "issued", "partial", "paid", "overdue", "void"]),
  journalEntryId: z.string().optional(),
  createdAt: z.string().datetime(),
});

const transactionSchema = z.object({
  id: z.string().min(1),
  entityId: z.string().min(1),
  externalId: z.string().min(1).max(512),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: moneySchema,
  flow: z.enum(["inflow", "outflow"]),
  description: z.string().max(2000),
  reference: z.string().max(512),
  counterparty: z.string().max(512).optional(),
  status: z.enum(["unreviewed", "suggested", "posted", "excluded"]),
  matchId: z.string().optional(),
  journalEntryId: z.string().optional(),
  createdAt: z.string().datetime(),
});

const matchSchema = z.object({
  id: z.string().min(1),
  entityId: z.string().min(1),
  bankTransactionId: z.string().min(1),
  status: z.enum(["proposed", "approved", "rejected", "unmatched"]),
  confidence: z.number().finite().min(0).max(1),
  rationale: z.array(z.string().max(1000)),
  allocations: z.array(z.object({ invoiceId: z.string().min(1), amount: moneySchema })),
  suggestedAccountId: z.string().optional(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
});

export const storageStateSchema = z
  .object({
    version: z.literal(1),
    organization: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      createdAt: z.string().datetime(),
    }),
    entity: z.object({
      id: z.string().min(1),
      organizationId: z.string().min(1),
      name: z.string().min(1),
      legalName: z.string().min(1),
      currency: currencySchema,
      timezone: z.string().min(1),
      settings: settingsSchema,
    }),
    accounts: z.array(accountSchema),
    customers: z.array(
      z.object({
        id: z.string().min(1),
        entityId: z.string().min(1),
        name: z.string().min(1),
        email: z.string().email(),
        company: z.string().optional(),
        currency: currencySchema,
        createdAt: z.string().datetime(),
      }),
    ),
    invoices: z.array(invoiceSchema),
    transactions: z.array(transactionSchema),
    matches: z.array(matchSchema),
    journalEntries: z.array(journalSchema),
    categoryRules: z.array(
      z.object({
        id: z.string().min(1),
        entityId: z.string().min(1),
        name: z.string().min(1),
        keywords: z.array(z.string().min(1)),
        accountId: z.string().min(1),
        flow: z.enum(["inflow", "outflow"]).optional(),
        priority: z.number().int(),
        active: z.boolean(),
      }),
    ),
    auditEvents: z.array(
      z.object({
        id: z.string().min(1),
        entityId: z.string().min(1),
        actor: z.string().min(1),
        action: z.string().min(1),
        objectType: z.string().min(1),
        objectId: z.string().min(1),
        detail: z.string().max(4000),
        createdAt: z.string().datetime(),
      }),
    ),
  })
  .strict();

export type StorageState = z.infer<typeof storageStateSchema>;

export function validateStorageState(value: unknown): StorageState {
  return storageStateSchema.parse(value);
}

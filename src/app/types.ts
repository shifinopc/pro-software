// ─────────────────────────────────────────────────────────────
// SHARED DOMAIN TYPES
// Extracted from App.tsx so screens, lib helpers, and tests can
// share one source of truth. Pure type declarations — no runtime.
// ─────────────────────────────────────────────────────────────
export type Role = "super_admin" | "admin" | "pro_officer" | "accountant" | "client_admin";
export type Screen = "dashboard" | "my_task" | "tasks" | "compliance" | "clients" | "finance" | "reports" | "activity" | "calendar" | "approvals" | "sla" | "audit" | "ai_assistant" | "knowledge_base" | "country_rules" | "doc_templates" | "multi_tenant" | "bi_dashboard" | "kpi_builder" | "security_center" | "object_builder" | "form_builder" | "workflow_builder" | "workflow_runs" | "my_work" | "service_packages" | "marketplace" | "notification_engine" | "settings" | "portal" | "packages";
export type TaskStatus = "todo" | "in_progress" | "review" | "done";
export type ComplianceStatus = "valid" | "expiring" | "overdue" | "in_progress";
export type InvoiceStatus = "paid" | "pending" | "overdue" | "draft";
export type KanbanColumn = "backlog" | "in_progress" | "review" | "done";
export type Priority = "critical" | "high" | "medium" | "low";

export interface TaskBlock { runIds: string[]; resumeWorkflowId?: string; autoResume?: boolean; reason?: string; }
export interface Task { id: string; title: string; client: string; assignee: string; priority: Priority; dueDate: string; status: TaskStatus; docType: string; archived?: boolean; complianceDocId?: string; workflowInstanceId?: string; employeeId?: string; customData?: Record<string, string>; blockedBy?: TaskBlock | null; }
export interface DocVersion { at: string; by?: string; oldExpiry?: string; newExpiry?: string; oldNumber?: string; newNumber?: string; fee?: string; receipt?: string; note?: string; }
export interface ComplianceDoc { id: string; name?: string; person: string; employeeId?: string; client: string; docType: string; expiryDate: string; status: ComplianceStatus; daysLeft: number; docNumber?: string; issueDate?: string; issuingAuthority?: string; history?: DocVersion[]; }
export interface KanbanCard { id: string; title: string; client: string; assignee: string; priority: Priority; dueDate: string; column: KanbanColumn; docType: string; checklist: { id: string; label: string; done: boolean }[]; }
export interface Client { id: string; name: string; cr: string; industry: string; employees: number; status: "prospect" | "onboarding" | "active" | "suspended" | "inactive"; overdue: number; expiring: number; contact: string; email: string; phone: string; city: string; groupId?: string; salesRepId?: string; customData?: Record<string, string>; }
export interface ClientGroup { id: string; name: string; contact: string; email: string; salesRepId?: string; }
export interface Package { id: string; name: string; tier: string; basePrice: number; billingCycle: "monthly" | "yearly"; empMin: number; empMax: number; features: string[]; color: string; }
export interface Subscription { id: string; scope: "group" | "company"; refId: string; packageId: string; price: number; startDate: string; endDate: string; daysLeft: number; autoRenew: boolean; custom: boolean; }
export interface UpgradeRequest { id: string; clientId: string; clientName: string; fromPackageId: string; toPackageId: string; note: string; status: "pending" | "approved" | "rejected"; date: string; }
export interface SiteCredential { id: string; label: string; url: string; username: string; password: string; notes: string; }
export interface Invoice { id: string; number: string; client: string; companyId?: string | null; amount: number; currency: string; status: InvoiceStatus; date: string; dueDate: string; services: string; }
export interface ActivityItem { id: string; type: "renewal" | "task" | "client" | "payment" | "alert" | "compliance" | "finance"; message?: string; text?: string; user?: string; time: string; date?: string; client?: string; icon?: string; }
export interface Employee { id: string; name: string; role: string; iqamaExpiry: string; status: "valid" | "expiring" | "overdue"; customData?: Record<string, string>; archived?: boolean; history?: { at: string; event: string; detail?: string; by?: string }[]; }
// Admin-defined custom employee field (no-code Form Builder)
export interface CustomFieldDef { id: string; entity: string; label: string; type: "text" | "number" | "date" | "dropdown"; options?: string[]; required?: boolean; sortOrder?: number; }
// A dynamic field on a document type / form. `key` (form-driven Add Client) maps a field to a real
// Company column (name/cr/industry/city/contact/email/phone) or a relationship (group/salesRep/package); no key = custom → customData.
export interface DocFieldDef { id: string; label: string; type: "text" | "number" | "date" | "dropdown"; options?: string[]; required?: boolean; key?: string; }
// A renewal prerequisite rule on a document type
export interface DocPrereq { requiresDocType: string; minMonths: number; }
// Admin-defined document type with its own dynamic fields (Document Types manager)
export interface DocType { id: string; name: string; fields: DocFieldDef[]; prereqs?: DocPrereq[]; leadDays?: number; defaultFee?: number; requiresApproval?: boolean; defaultAssigneeRole?: string; subjectKind?: "employee" | "company"; }
// Admin-defined custom object/record type (Object Builder) + its records.
// `appliesTo` (Form Builder only): "" standalone | "employee" | "client" — binds the form's fields to that record's Add form.
export interface CustomObjectDef { id: string; name: string; icon?: string; fields: DocFieldDef[]; appliesTo?: string; }
export interface CustomRecordRow { id: string; objectId: string; data: Record<string, string>; }
export interface Notification { id: string; type: "overdue" | "expiring" | "payment" | "task" | "system"; title: string; message: string; time: string; read: boolean; }

// Result of a renewal-prerequisite check (see lib/domain.prereqFailures)
export type PrereqFailure = { requiresDocType: string; minMonths: number; prereqDoc?: ComplianceDoc; months: number };

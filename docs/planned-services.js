/**
 * The services designed but not yet configured.
 *
 * Unlike Part One, this cannot be read out of the application — it does not exist there yet. So it is
 * written down here, in the SAME vocabulary the engine uses (step, owner, target, checklist, fields,
 * document issued), which is what makes each one a configuration job rather than a fresh design.
 *
 * `needs` names what must exist first: document types the system does not carry, authorities not yet
 * set up, and the three places where the engine itself needs work before the service can run at all.
 * A plan that hides its prerequisites is a plan that slips.
 *
 * PRO = PRO Officer, ACC = Accountant, HR = HR Officer.
 */
const P = 'PRO Officer', A = 'Accountant', H = 'HR Officer';

// [label, owner, target, collects[], records[], issues?]
const S = (label, owner, target, collects = [], records = [], issues = null) =>
  ({ label, owner, target, collects, records, issues });

module.exports = [
// ══════════════════════════════ COMPANY COMPLIANCE ══════════════════════════════
{
  group: 'Company compliance', name: 'Commercial Registration Renewal', authority: 'Ministry of Commerce',
  trigger: 'Starts by itself 45 days before the CR falls due.', entity: 'The company',
  needs: ['Document type: Commercial Registration (company)', 'Authority: MC — Ministry of Commerce'],
  note: 'Saudi’s new Commercial Register Law (April 2026) replaced annual renewal with an annual confirmation of the register’s data. Confirm with the client which their portal asks for — the flow below is identical either way.',
  steps: [
    S('Pre-Renewal Gate Check', P, '48 hours',
      ['ZATCA / Zakat certificate current', 'GOSI certificate current', 'Chamber membership status', 'Nitaqat band permits government services', 'National address valid', 'No outstanding MC violations', 'CR data still correct'],
      ['Is the company clear to renew? (ready / blocked)', 'What is blocking it']),
    S('Clear the Blocking Item', P, '7 days', [], ['What was done to clear it']),
    S('Confirm Fee and Client Approval', P, '48 hours', [],
      ['Renewal term', 'MC fee (SAR)', 'Chamber subscription tier', 'Client decision (approved / declined)', 'Who approved it', 'Date approved']),
    S('Renew Chamber Membership', P, '72 hours', [], ['Chamber receipt number', 'Date paid']),
    S('Pay MC Fees', A, '48 hours', [], ['Payment reference', 'Date paid']),
    S('Renew on the MC Portal', P, '24 hours', [], ['Portal reference', 'Date submitted']),
    S('Portal Blocked — Resolve', P, '72 hours', [], ['What the portal refused on']),
    S('Record the Renewed CR', P, '24 hours', [], ['CR number (unchanged)', 'New expiry date'], 'Commercial Registration'),
    S('Update Related Records', P, '72 hours',
      ['MISA licence details', 'Qiwa / MHRSD establishment file', 'GOSI establishment record', 'VAT registration', 'Bank mandate', 'Municipal licence'], []),
  ],
},
{
  group: 'Company compliance', name: 'Chamber of Commerce Membership Renewal', authority: 'Chamber of Commerce',
  trigger: 'Starts by itself 30 days before the membership falls due.', entity: 'The company',
  needs: ['Document type: Chamber Membership (company)', 'Authority: Chamber of Commerce'],
  steps: [
    S('Verify CR and Membership', P, '24 hours', ['CR valid and matching', 'Current membership certificate', 'Membership category correct'], ['Membership number', 'Current expiry']),
    S('Confirm Category and Fee', P, '24 hours', [], ['Membership category', 'Subscription fee (SAR)', 'Client decision', 'Who approved it']),
    S('Submit Renewal and Confirm by OTP', P, '24 hours', [], ['Chamber reference', 'OTP confirmed (yes / no)']),
    S('Pay the SADAD Invoice', A, '48 hours', [], ['SADAD bill number', 'Amount paid', 'Date paid']),
    S('Download the Certificate', P, '24 hours', [], ['New membership number', 'New expiry date'], 'Chamber Membership'),
  ],
},
{
  group: 'Company compliance', name: 'GOSI Establishment Registration / Update', authority: 'GOSI',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'The company',
  needs: ['Document type: GOSI Establishment Certificate (company)'],
  steps: [
    S('Verify Establishment Details', P, '24 hours', ['CR copy', 'National address', 'Authorised signatory ID', 'Bank IBAN letter'], ['GOSI establishment number', 'Branch count']),
    S('Check Outstanding Contributions', P, '24 hours', [], ['Any amount outstanding (SAR)', 'Cleared? (yes / no)']),
    S('Settle Outstanding Amount', A, '72 hours', [], ['Payment reference']),
    S('Submit Registration / Update', P, '48 hours', [], ['GOSI reference number', 'Date submitted']),
    S('Download GOSI Certificate', P, '24 hours', [], ['Certificate number', 'Issue date'], 'GOSI Establishment Certificate'),
  ],
},
{
  group: 'Company compliance', name: 'National Address (SPL)', authority: 'SPL — Saudi Post',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'The company',
  needs: ['Document type: National Address Certificate (company)', 'Authority: SPL'],
  note: 'Worth doing early: the bank account, Fasah and several government portals all read this address, so one correct record is reused rather than re-entered.',
  steps: [
    S('Collect Address Details', P, '48 hours', ['Lease or title deed', 'Building photo if required'], ['Building number', 'Street', 'District', 'City', 'Postal code', 'Additional number']),
    S('Verify Against the Portal', P, '24 hours', [], ['Matches the portal? (yes / no)', 'What differs']),
    S('Register or Update the Address', P, '48 hours', [], ['SPL reference', 'Date submitted']),
    S('Download the Address Certificate', P, '24 hours', [], ['Certificate reference', 'Issue date'], 'National Address Certificate'),
  ],
},
{
  group: 'Company compliance', name: 'CR Amendment', authority: 'Ministry of Commerce',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'The company',
  needs: ['Document type: Commercial Registration (company)'],
  steps: [
    S('Confirm What Is Changing', P, '24 hours', [], ['What is being amended (name / activity / capital / address / manager / partners)', 'New value', 'Reason']),
    S('Collect Supporting Documents', P, '5 days', ['Board or partner resolution', 'Amended articles if applicable', 'Authorised signatory ID', 'Supporting licence if the activity is regulated'], []),
    S('Check Consequences', P, '48 hours', ['MISA licence permits the change', 'Municipal licence permits the change', 'Nitaqat effect understood'], ['Any approval needed first']),
    S('Confirm Fee and Client Approval', P, '48 hours', [], ['MC fee (SAR)', 'Client decision', 'Who approved it']),
    S('Pay and Submit', A, '48 hours', [], ['Payment reference', 'MC reference']),
    S('Record the Amended CR', P, '24 hours', [], ['CR number', 'Amended field confirmed', 'New expiry if changed'], 'Commercial Registration'),
    S('Cascade the Change', P, '5 days', ['Chamber record', 'GOSI establishment', 'Qiwa establishment', 'VAT registration', 'Bank mandate', 'MISA licence'], []),
  ],
},
{
  group: 'Company compliance', name: 'CR Cancellation', authority: 'Ministry of Commerce',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'The company',
  needs: ['Document type: Commercial Registration (company)'],
  note: 'Deliberately slow and gated. A cancellation with staff still sponsored or liabilities open leaves the owner personally exposed.',
  steps: [
    S('Confirm the Instruction', P, '48 hours', [], ['Who instructed it', 'Date instructed', 'Reason']),
    S('Clearance Check', P, '5 days', ['All employees exited or transferred', 'GOSI cleared and closed', 'ZATCA / Zakat cleared', 'No open government violations', 'Chamber settled', 'Bank accounts settled'], ['Anything outstanding']),
    S('Resolve Outstanding Items', P, '15 days', [], ['What was cleared']),
    S('Owner Confirmation', H, '72 hours', [], ['Confirmed by', 'Date']),
    S('Submit Cancellation', P, '48 hours', [], ['MC reference', 'Date submitted']),
    S('Record the Cancellation', P, '24 hours', [], ['Cancellation certificate number', 'Effective date']),
  ],
},
{
  group: 'Company compliance', name: 'Corporate Bank Account Opening', authority: 'Bank',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'The company',
  needs: ['Document type: Bank Account Confirmation (company)', 'Authority: Bank'],
  note: 'The system records the application and its progress only. No banking credentials, card details or one-time passwords are stored anywhere in it.',
  steps: [
    S('Collect the Application Pack', P, '5 days',
      ['CR copy', 'Articles of association', 'Chamber certificate', 'National address certificate', 'VAT certificate', 'Authorised signatory IDs', 'Board resolution to open the account', 'Shareholder register'], []),
    S('Verify Signatories and Shareholders', P, '48 hours', [], ['Authorised signatory', 'Signing limits', 'Shareholding confirmed (yes / no)']),
    S('Prepare and Review the Application', P, '48 hours', [], ['Client review complete (yes / no)', 'Who reviewed it']),
    S('Submit to the Bank', P, '24 hours', [], ['Bank reference', 'Date submitted', 'Relationship manager']),
    S('Respond to Bank Queries', P, '72 hours', [], ['What was asked', 'What was provided']),
    S('Account Opened', P, '24 hours', [], ['Account number', 'IBAN', 'Branch'], 'Bank Account Confirmation'),
  ],
},
{
  group: 'Company compliance', name: 'Customs Declaration (Fasah)', authority: 'Fasah',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'The company',
  needs: ['Authority: Fasah', 'Document type: Customs Declaration (company)'],
  steps: [
    S('Confirm Importer / Exporter Details', P, '24 hours', ['CR with import/export activity', 'Customs client number'], ['Direction (import / export)']),
    S('Collect Shipment Documents', P, '48 hours', ['Commercial invoice', 'Packing list', 'Bill of lading or airway bill', 'Certificate of origin', 'Insurance certificate  (only if it applies)'], ['Shipment reference', 'Port of entry', 'Expected arrival']),
    S('Prepare and Submit the Declaration', P, '24 hours', [], ['Declaration number', 'Date submitted']),
    S('Customs Processing', P, '5 days', [], ['Customs outcome (cleared / inspection / query)', 'What was asked']),
    S('Pay Duties and Charges', A, '24 hours', [], ['Duty amount (SAR)', 'Payment reference']),
    S('Record Clearance', P, '24 hours', [], ['Clearance reference', 'Release date'], 'Customs Declaration'),
  ],
},
{
  group: 'Company compliance', name: 'VAT Return Filing', authority: 'ZATCA', blocked: 'Needs the recurring trigger',
  trigger: 'Should start by itself each period. Needs a recurring trigger, which the engine does not have yet.', entity: 'The company',
  needs: ['ENGINE: a recurring (monthly / quarterly) trigger', 'ENGINE: client approval from the portal', 'Document type: VAT Return (company)'],
  steps: [
    S('Open the Period', P, '24 hours', [], ['Period', 'Filing deadline']),
    S('Collect Sales and Purchases', A, '5 days', ['Sales invoices', 'Purchase invoices', 'Credit and debit notes', 'Import VAT statements'], []),
    S('Reconcile and Calculate', A, '72 hours', [], ['Output VAT', 'Input VAT', 'Net payable or refundable']),
    S('Client Review and Approval', P, '72 hours', [], ['Client decision (approved / query)', 'Who approved it', 'Date approved']),
    S('Submit to ZATCA', P, '24 hours', [], ['ZATCA reference', 'Date filed']),
    S('Pay via SADAD', A, '48 hours', [], ['SADAD bill number', 'Amount paid', 'Date paid']),
    S('File the Return Receipt', P, '24 hours', [], ['Receipt reference'], 'VAT Return'),
  ],
},
{
  group: 'Company compliance', name: 'Payroll / WPS Submission (Mudad)', authority: 'Mudad', blocked: 'Needs the recurring trigger',
  trigger: 'Should start by itself each month. Needs a recurring trigger, which the engine does not have yet.', entity: 'The company',
  needs: ['ENGINE: a recurring (monthly) trigger', 'Authority: Mudad'],
  steps: [
    S('Open the Payroll Month', H, '24 hours', [], ['Payroll month', 'Employees in scope', 'Total salary (SAR)']),
    S('Validate Employee Data', H, '48 hours', ['Every employee has an IBAN', 'Iqama numbers valid', 'Wages match the Qiwa contract'], ['Records failing validation']),
    S('Correct Failing Records', H, '48 hours', [], ['What was corrected']),
    S('Upload the WPS File', A, '24 hours', [], ['File reference', 'Date uploaded']),
    S('Record the Compliance Result', P, '24 hours', [], ['Mudad status', 'WPS compliance percentage', 'Exception employees']),
  ],
},
{
  group: 'Company compliance', name: 'Vehicle Services (Tamm)', authority: 'Tamm', blocked: 'Needs a vehicle record',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'A company vehicle',
  needs: ['ENGINE: a vehicle record — nothing in the system models a vehicle today', 'Authority: Tamm', 'Document types: Vehicle Registration, Vehicle Insurance'],
  steps: [
    S('Select Vehicle and Service', P, '24 hours', [], ['Plate number', 'Service required']),
    S('Verify Registration and Insurance', P, '24 hours', ['Registration card current', 'Insurance policy current', 'Periodic inspection valid', 'No outstanding traffic fines'], ['Anything outstanding']),
    S('Settle Fines or Renew Insurance', A, '72 hours', [], ['Amount paid', 'Payment reference']),
    S('Perform the Transaction', P, '48 hours', [], ['Tamm reference', 'Date submitted']),
    S('Record the Updated Document', P, '24 hours', [], ['New expiry date'], 'Vehicle Registration'),
  ],
},
// ══════════════════════════════ EMPLOYEE SERVICES ══════════════════════════════
{
  group: 'Employee services', name: 'Iqama Renewal', authority: 'Muqeem',
  trigger: 'Starts by itself 60 days before the Iqama expires, and holds if a prerequisite is not met.', entity: 'One employee',
  needs: ['Nothing — every document type, authority and checklist it needs already exists'],
  note: 'The highest-volume service, and the one to configure first: every piece it needs is already in the system, including the prerequisite hold on passport validity and health insurance.',
  steps: [
    S('Prerequisite Check', P, '24 hours',
      ['Passport valid at least 6 months', 'Health insurance current', 'Work permit current', 'No government restriction on the employee', 'No outstanding traffic or labour fines'], ['Anything blocking renewal']),
    S('Resolve the Blocking Item', P, '7 days', [], ['What was done']),
    S('Confirm Fee and Client Approval', P, '48 hours', [], ['Renewal term (1 year / 2 years)', 'Government fee (SAR)', 'Client decision', 'Who approved it']),
    S('Pay the Government Fee', A, '48 hours', [], ['Payment reference', 'Date paid']),
    S('Submit the Renewal', P, '24 hours', [], ['Muqeem reference', 'Date submitted']),
    S('Record the Renewed Iqama', P, '24 hours', [], ['Iqama number (unchanged)', 'New expiry date'], 'Iqama'),
    S('Give the Employee the Iqama', P, '48 hours', [], ['Handed over to', 'Date']),
  ],
},
{
  group: 'Employee services', name: 'Work Permit Renewal', authority: 'Qiwa',
  trigger: 'Starts by itself 30 days before the work permit expires.', entity: 'One employee',
  needs: ['Nothing — the Work Permit document type and Qiwa are already set up'],
  steps: [
    S('Check Establishment and Employee', P, '24 hours', ['Establishment active on Qiwa', 'Nitaqat band permits the renewal', 'Iqama valid', 'Contract authenticated'], ['Anything blocking it']),
    S('Confirm Fee and Client Approval', P, '48 hours', [], ['Government fee (SAR)', 'Client decision', 'Who approved it']),
    S('Pay the Fee', A, '48 hours', [], ['Payment reference']),
    S('Submit on Qiwa', P, '24 hours', [], ['Qiwa reference', 'Date submitted']),
    S('Record the Renewed Permit', P, '24 hours', [], ['Permit number', 'New expiry date'], 'Work Permit'),
  ],
},
{
  group: 'Employee services', name: 'Health Insurance Renewal', authority: 'CCHI',
  trigger: 'Starts by itself 30 days before the policy expires.', entity: 'One employee',
  needs: ['Nothing — the Health Insurance document type and CCHI are already set up'],
  steps: [
    S('Confirm Cover Required', P, '24 hours', [], ['Class of cover', 'Dependants included (yes / no)']),
    S('Obtain Quotation', P, '72 hours', [], ['Insurer', 'Premium (SAR)']),
    S('Client Approval', P, '48 hours', [], ['Client decision', 'Who approved it']),
    S('Pay the Premium', A, '48 hours', [], ['Payment reference']),
    S('Record the Policy', P, '24 hours', [], ['Policy number', 'New expiry date'], 'Health Insurance'),
  ],
},
{
  group: 'Employee services', name: 'Qiwa Contract Authentication', authority: 'Qiwa',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'One employee',
  needs: ['Nothing — already set up'],
  steps: [
    S('Prepare the Contract', H, '48 hours', ['Signed offer letter', 'Job description', 'Salary breakdown'], ['Job title', 'Basic salary', 'Allowances', 'Contract term']),
    S('Upload to Qiwa', P, '24 hours', [], ['Qiwa contract reference']),
    S('Employee Acceptance', P, '5 days', [], ['Accepted by employee (yes / no)', 'Date accepted']),
    S('Record the Authenticated Contract', P, '24 hours', [], ['Contract number', 'Effective date'], 'Qiwa Employment Contract'),
  ],
},
{
  group: 'Employee services', name: 'New Employee Work Visa', authority: 'Qiwa / MOFA',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'One employee',
  needs: ['Nothing — the Work Visa document type, Qiwa and MOFA are already set up'],
  note: 'Currently part of Employee Onboarding. Splitting it out lets a visa be raised for a candidate who is not yet an employee, which is what actually happens.',
  steps: [
    S('Check Quota and Eligibility', P, '48 hours', ['Visa quota available', 'Nitaqat band permits the hire', 'Profession open to the nationality', 'Establishment active'], ['Quota remaining']),
    S('Candidate Details', P, '72 hours', ['Passport copy valid 6+ months', 'Photograph', 'Qualification certificates', 'Medical fitness certificate'], ['Full name as printed in the passport', 'Nationality', 'Profession', 'Visa type']),
    S('Submit the Visa Application', P, '48 hours', [], ['Qiwa reference', 'Date submitted']),
    S('Pay the Visa Fee', A, '48 hours', [], ['Fee (SAR)', 'Payment reference']),
    S('Government Approval', P, '10 days', [], ['Outcome (approved / more information / refused)', 'Visa authorisation number']),
    S('Embassy and Stamping', P, '15 days', ['Attested certificates', 'Medical report', 'Police clearance  (only if it applies)'], ['Embassy reference', 'Visa number', 'Visa expiry']),
    S('Record the Visa', P, '24 hours', [], ['Visa number', 'Expiry date'], 'Work Visa'),
    S('Confirm Arrival', P, '30 days', [], ['Date of arrival', 'Port of entry']),
  ],
},
{
  group: 'Employee services', name: 'Exit / Re-entry Visa', authority: 'Muqeem',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'One employee',
  needs: ['Document type: Exit / Re-entry Visa (employee)'],
  steps: [
    S('Check Eligibility', P, '24 hours', ['Iqama valid for the whole period', 'Passport valid', 'No travel ban or restriction', 'No outstanding fines'], ['Anything blocking it']),
    S('Confirm Dates and Fee', P, '24 hours', [], ['Departure date', 'Return date', 'Single or multiple', 'Fee (SAR)', 'Who approved it']),
    S('Pay and Issue', A, '24 hours', [], ['Payment reference', 'Visa number', 'Valid until'], 'Exit / Re-entry Visa'),
    S('Give the Employee the Visa', P, '24 hours', [], ['Handed over to', 'Date']),
  ],
},
{
  group: 'Employee services', name: 'Final Exit', authority: 'Muqeem',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'One employee',
  needs: ['Document type: Final Exit Visa (employee)'],
  note: 'Nothing here can be reversed once the visa is issued, which is why the clearance step comes before it and carries a named approver.',
  steps: [
    S('Clearance Check', H, '5 days', ['Resignation or termination letter', 'Company property returned', 'Loans and advances settled', 'GOSI contributions up to date', 'No outstanding fines'], ['Anything outstanding']),
    S('Final Settlement', A, '5 days', [], ['End of service benefit (SAR)', 'Outstanding salary', 'Deductions', 'Net payable']),
    S('Employee Acknowledgement', H, '72 hours', [], ['Acknowledged by employee (yes / no)', 'Date']),
    S('Cancel Work Permit and Contract', P, '48 hours', [], ['Qiwa reference']),
    S('Issue the Final Exit Visa', P, '48 hours', [], ['Visa number', 'Valid until'], 'Final Exit Visa'),
    S('Confirm Departure', P, '30 days', [], ['Date of departure', 'Confirmed on Muqeem (yes / no)']),
  ],
},
{
  group: 'Employee services', name: 'Profession Change', authority: 'Qiwa / HRSD',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'One employee',
  needs: ['Nothing — Qiwa and MHRSD are already set up'],
  steps: [
    S('Confirm the Change', P, '24 hours', [], ['Current profession', 'Requested profession', 'Reason']),
    S('Eligibility Check', P, '48 hours', ['Establishment active and licensed', 'Nitaqat band permits the change', 'Profession open to the nationality', 'Professional certificate held where required', 'Iqama and contract current'], ['Anything blocking it']),
    S('Collect Supporting Certificates', P, '5 days', ['Attested qualification certificate', 'Professional accreditation  (only if it applies)', 'Experience letters  (only if it applies)'], []),
    S('Submit on Qiwa', P, '48 hours', [], ['Qiwa reference', 'Fee (SAR)']),
    S('Employee Approval', P, '72 hours', [], ['Accepted by employee (yes / no)']),
    S('Government Processing', P, '7 days', [], ['Outcome (approved / refused)', 'Reason if refused']),
    S('Update the Employee Record', P, '24 hours', ['Iqama shows the new profession', 'Qiwa contract updated', 'GOSI record updated'], ['New profession confirmed']),
  ],
},
{
  group: 'Employee services', name: 'Employee Transfer (Sponsorship)', authority: 'Qiwa',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'One employee',
  needs: ['Nothing — the checklists for this already exist from Employee Onboarding'],
  steps: [
    S('Check Transfer Eligibility', P, '48 hours', ['Current employer contract details', 'Nitaqat band permits the transfer', 'No outstanding fines on either party', 'Employee consent recorded'], ['Anything blocking it']),
    S('Raise the Transfer Request', P, '48 hours', [], ['Qiwa request number', 'Date raised']),
    S('Previous Employer Response', P, '10 days', [], ['Outcome (approved / rejected / lapsed)', 'Reason if rejected']),
    S('Pay the Transfer Fee', A, '48 hours', [], ['Fee (SAR)', 'Payment reference']),
    S('Complete the Sponsorship Transfer', P, '5 days', ['Iqama sponsor updated', 'New contract authenticated', 'GOSI record moved'], ['Transfer effective date'], 'Iqama'),
  ],
},
{
  group: 'Employee services', name: 'GOSI Employee Registration / Update', authority: 'GOSI',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'One employee',
  needs: ['Nothing — the GOSI Employee Registration document type already exists'],
  steps: [
    S('Confirm Employee Details', P, '24 hours', ['Iqama or national ID copy', 'Signed contract'], ['Date of joining', 'Basic wage', 'Housing allowance', 'Occupation']),
    S('Check Eligibility and Existing Record', P, '24 hours', [], ['Already registered elsewhere? (yes / no)', 'GOSI number if held']),
    S('Submit Registration or Update', P, '48 hours', [], ['GOSI reference', 'Date submitted']),
    S('Record the Registration', P, '24 hours', [], ['GOSI number', 'Effective date'], 'GOSI Employee Registration'),
  ],
},
{
  group: 'Employee services', name: 'Termination and Final Settlement', authority: '—',
  trigger: 'Started by HR when you ask for it.', entity: 'One employee',
  needs: ['Nothing — this is an internal process with no government submission of its own'],
  note: 'Ends by handing over to Final Exit for a non-Saudi employee, or to GOSI deregistration for a Saudi one.',
  steps: [
    S('Record the Instruction', H, '24 hours', ['Resignation or termination letter', 'Notice period confirmation'], ['Type (resignation / termination / end of contract)', 'Last working day', 'Reason']),
    S('Calculate the Settlement', A, '5 days', [], ['Years of service', 'End of service benefit (SAR)', 'Unused leave', 'Deductions', 'Net payable']),
    S('Manager Approval', H, '72 hours', [], ['Approved by', 'Date']),
    S('Employee Acknowledgement', H, '72 hours', [], ['Acknowledged (yes / no)', 'Date']),
    S('Pay the Settlement', A, '5 days', [], ['Payment reference', 'Date paid']),
    S('Close the Employee Record', H, '48 hours', ['Company property returned', 'Access and accounts revoked', 'Payroll stopped'], ['Record closed on']),
  ],
},
{
  group: 'Employee services', name: 'Employee Insurance Assistance', authority: 'Insurer',
  trigger: 'Starts by itself 30 days before the policy expires.', entity: 'One employee',
  needs: ['Document type: Insurance Policy (employee or company)'],
  steps: [
    S('Confirm What Is Needed', P, '24 hours', [], ['Type of cover', 'Existing policy number', 'Current expiry']),
    S('Obtain Quotations', P, '5 days', [], ['Insurer', 'Premium (SAR)', 'Cover level']),
    S('Client Approval', P, '72 hours', [], ['Client decision', 'Who approved it']),
    S('Pay and Issue', A, '48 hours', [], ['Payment reference', 'Policy number', 'New expiry'], 'Insurance Policy'),
  ],
},
{
  group: 'Employee services', name: 'Employee Medical Assistance', authority: 'Healthcare provider',
  trigger: 'Started by your PRO officer when you ask for it.', entity: 'One employee',
  needs: ['Nothing new'],
  note: 'The system records the CASE and the documents required — appointment made, report received. It deliberately holds no medical detail: what is wrong with somebody is not a fact this software needs to do its job.',
  steps: [
    S('Record the Request', P, '24 hours', [], ['What is needed (appointment / medical report / fitness certificate / insurance coordination)', 'Urgency']),
    S('Confirm Insurance Cover', P, '24 hours', ['Insurance card', 'Policy in force'], ['Insurer', 'Cover applies (yes / no)']),
    S('Coordinate with the Provider', P, '72 hours', [], ['Provider', 'Appointment date', 'Reference']),
    S('Collect the Document', P, '5 days', ['Medical report or certificate received'], ['Date received']),
    S('Close the Case', P, '24 hours', [], ['Outcome', 'Handed to']),
  ],
},
];

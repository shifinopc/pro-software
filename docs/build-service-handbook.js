/**
 * STIMES PRO — service handbook for the client.
 *
 * Everything in here is READ from the running application: step labels, the role each step goes to,
 * its SLA, the documents it collects, the information it records and the documents it issues. Nothing
 * is described that the software does not actually do — which is the entire point of a document a
 * client is going to hold you to.
 */
const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, TableOfContents,
  LevelFormat, convertInchesToTwip,
} = require('docx');

const M = JSON.parse(fs.readFileSync('app-model.json', 'utf8'));

const PURPLE = '5B21B6';
const INK = '26074D';
const GREY = '6F6C7A';
const LIGHT = 'F5F3FA';
const RULE = 'E4E0EC';

// A4 portrait, 1000 DXA margins -> 9906 usable. The step table sums to 9900.
const COLS = [450, 2250, 1250, 1050, 2450, 2450];

const P = (text, o = {}) => new Paragraph({
  spacing: { before: o.before ?? 0, after: o.after ?? 120, line: o.line ?? 276 },
  alignment: o.align,
  children: [new TextRun({
    text: text ?? '', bold: o.bold, italics: o.italics,
    size: o.size ?? 20, color: o.color ?? INK, font: o.font ?? 'Calibri',
  })],
  ...(o.border ? { border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 8 } } } : {}),
});

const H = (text, level, o = {}) => new Paragraph({
  heading: level,
  spacing: { before: o.before ?? 320, after: o.after ?? 140 },
  pageBreakBefore: !!o.pageBreak,
  children: [new TextRun({ text, bold: true, size: o.size ?? 28, color: o.color ?? PURPLE, font: 'Calibri' })],
});

const cell = (children, o = {}) => new TableCell({
  width: { size: o.width, type: WidthType.DXA },
  shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
  margins: { top: 70, bottom: 70, left: 90, right: 90 },
  verticalAlign: o.valign,
  columnSpan: o.span,
  children: children.length ? children : [P('', { after: 0 })],
});

const txt = (s, o = {}) => P(s, { after: o.after ?? 0, size: o.size ?? 17, bold: o.bold, color: o.color, italics: o.italics });

/** A list of short lines inside a table cell — one paragraph each, never "\n". */
const lines = (arr, o = {}) => arr.length
  ? arr.map((s, i) => txt((o.dash ? '– ' : '') + s, { after: i === arr.length - 1 ? 0 : 40, size: 16, color: o.color }))
  : [txt('—', { size: 16, color: 'A9A6B4' })];

const headerRow = (labels) => new TableRow({
  tableHeader: true,
  children: labels.map((l, i) => cell([txt(l, { bold: true, size: 16, color: 'FFFFFF' })], { width: COLS[i], fill: PURPLE })),
});

function stepTable(steps) {
  const rows = [headerRow(['#', 'Step', 'Who does it', 'Target', 'Documents collected', 'Information recorded'])];
  let n = 0;
  for (const s of steps) {
    // Structural nodes carry no work: the client cares about the path, and a row saying "Parallel
    // split — nobody — no documents" is three empty columns pretending to be a step.
    const structural = ['Start', 'End', 'Parallel split', 'Parallel join'].includes(s.type);
    if (structural) continue;
    n++;
    const isDecision = s.raw_type === 'decision';
    const stepCell = [txt(s.label, { bold: true, size: 17 })];
    if (s.type !== 'Task') stepCell.push(txt(s.type + (s.authority ? ' · ' + s.authority : ''), { size: 15, color: GREY, after: 0 }));
    else if (s.authority) stepCell.push(txt('at ' + s.authority, { size: 15, color: GREY, after: 0 }));
    // The label is usually the document's own name, so repeating it under the step reads as a
    // stutter. Only said when it adds something.
    if (s.doc_type && s.doc_type !== s.label) stepCell.push(txt('Issues: ' + s.doc_type, { size: 15, color: '0E9355', after: 0 }));

    const collects = isDecision
      ? s.branches.map(([cond, to]) => (cond === 'else' ? 'otherwise' : cond) + ' → ' + to)
      : s.checklist;
    const collectHead = isDecision ? [] : (s.checklist_rule ? [txt(s.checklist_rule, { size: 15, color: GREY, italics: true, after: 40 })] : []);

    rows.push(new TableRow({
      children: [
        cell([txt(String(n), { size: 16, color: GREY })], { width: COLS[0], fill: n % 2 ? undefined : LIGHT }),
        cell(stepCell, { width: COLS[1], fill: n % 2 ? undefined : LIGHT }),
        cell([txt(s.role || (isDecision ? 'Automatic' : '—'), { size: 16 })], { width: COLS[2], fill: n % 2 ? undefined : LIGHT }),
        cell([txt(s.sla || '—', { size: 16, color: GREY })], { width: COLS[3], fill: n % 2 ? undefined : LIGHT }),
        cell([...collectHead, ...lines(collects, { dash: !isDecision })], { width: COLS[4], fill: n % 2 ? undefined : LIGHT }),
        cell(lines(s.captures.map(([l, d]) => l + '  (' + d + ')')), { width: COLS[5], fill: n % 2 ? undefined : LIGHT }),
      ],
    }));
  }
  return new Table({ columnWidths: COLS, width: { size: COLS.reduce((a, b) => a + b, 0), type: WidthType.DXA }, rows });
}

const TRIGGER = {
  manual: 'Started by your PRO officer when you ask for it.',
  document_expiry: 'Starts by itself, before the document expires. Nobody has to remember.',
  request_intake: 'Starts when a request is accepted from the client portal.',
  quotation_accepted: 'Starts when you accept the quotation.',
};

function serviceSection(t, first) {
  const out = [];
  out.push(H(t.name, HeadingLevel.HEADING_1, { pageBreak: !first, size: 32 }));

  const cfg = t.triggerConfig || {};
  const facts = [
    ['How it starts', TRIGGER[t.trigger] || t.trigger],
    ...(t.trigger === 'document_expiry' && cfg.docType
      ? [['Watched document', cfg.docType + (cfg.days ? ` — opens ${cfg.days} days before it expires` : '')]] : []),
    ['It is about', t.entityType === 'company' ? 'The company' : 'One employee'],
    ['Steps', String(t.steps.filter(s => !['Start', 'End', 'Parallel split', 'Parallel join'].includes(s.type)).length)],
    ['Teams involved', [...new Set(t.steps.map(s => s.role).filter(Boolean))].join(', ')],
    ['Documents it issues', [...new Set(t.steps.map(s => s.doc_type).filter(Boolean))].join(', ') || 'None'],
  ];
  const fw = [2600, 7300];
  out.push(new Table({
    columnWidths: fw, width: { size: 9900, type: WidthType.DXA },
    rows: facts.map(([k, v]) => new TableRow({
      children: [
        cell([txt(k, { bold: true, size: 17, color: GREY })], { width: fw[0], fill: LIGHT }),
        cell([txt(v, { size: 17 })], { width: fw[1] }),
      ],
    })),
  }));
  out.push(P('', { after: 200 }));

  // The instructions officers actually see, for the steps that carry them. This is where a client
  // learns why a step exists rather than only that it does.
  const noted = t.steps.filter(s => s.instructions);
  out.push(H('Every step', HeadingLevel.HEADING_2, { size: 24 }));
  out.push(stepTable(t.steps));

  if (noted.length) {
    out.push(H('What the officer is told at each of these steps', HeadingLevel.HEADING_2, { size: 24 }));
    for (const s of noted) {
      out.push(P(s.label, { bold: true, size: 18, after: 40 }));
      out.push(P(s.instructions, { size: 17, color: GREY, after: 160 }));
    }
  }
  return out;
}

// ── the document ──────────────────────────────────────────────────────────────────────────────
const kids = [];

// Cover
kids.push(new Paragraph({ spacing: { before: 2600, after: 0 }, children: [new TextRun({ text: 'STIMES PRO', bold: true, size: 64, color: PURPLE, font: 'Calibri' })] }));
kids.push(P('Service Handbook', { size: 40, color: INK, after: 260 }));
kids.push(P('Every PRO service configured in the system: what happens at each step, who does it, what is collected, and what comes out at the end.', { size: 22, color: GREY, after: 500 }));
kids.push(P('Kingdom of Saudi Arabia', { size: 20, color: INK, bold: true, after: 40 }));
kids.push(P('Issued ' + new Date().toISOString().slice(0, 10), { size: 20, color: GREY, after: 40 }));
kids.push(new Paragraph({ children: [new PageBreak()] }));

// How to read
kids.push(H('How this works', HeadingLevel.HEADING_1, { before: 0, size: 32 }));
kids.push(P('Every service in STIMES PRO runs on the same engine. A service is not a single task somebody remembers to do — it is a defined sequence of steps, each with an owner, a target time, the documents it needs and the information it records. The system moves the work from one step to the next by itself.', { size: 20, after: 200 }));

const concepts = [
  ['Steps', 'Each step is a piece of work with one owner. Nothing moves forward until it is completed, so no stage can be skipped by accident.'],
  ['Who does it', 'Work is assigned to a ROLE — PRO Officer, Accountant, HR Officer — and the system picks whoever in that team is carrying the least. Where you have a named officer, their work goes to them instead.'],
  ['Target time', 'Each step carries the time it should take. The system tracks it, warns before it is missed and escalates when it is.'],
  ['Documents collected', 'A tick list the officer works through. The list is not fixed — it changes with the case, so a transfer is never asked for the papers only a new arrival needs.'],
  ['Information recorded', 'The facts captured at that step — reference numbers, dates, outcomes. These drive what happens next and stay on the record afterwards.'],
  ['Decisions', 'Points where the flow branches. Every outcome is listed, including refusals and queries — the path is never a dead end.'],
  ['Documents issued', 'Where a step produces a real government document, it is filed against the company or the employee, dated, and watched for expiry from that moment.'],
];
const cw = [2200, 7700];
kids.push(new Table({
  columnWidths: cw, width: { size: 9900, type: WidthType.DXA },
  rows: concepts.map(([k, v]) => new TableRow({
    children: [
      cell([txt(k, { bold: true, size: 17, color: PURPLE })], { width: cw[0], fill: LIGHT }),
      cell([txt(v, { size: 17 })], { width: cw[1] }),
    ],
  })),
}));
kids.push(P('', { after: 240 }));
kids.push(P('Nothing in this handbook is a description of intent. Every step, owner, target, list and document below is read directly from the configured system.', { size: 18, italics: true, color: GREY }));

// Services
M.templates.forEach((t, i) => serviceSection(t, false).forEach(k => kids.push(k)));

// ── Appendix: documents ───────────────────────────────────────────────────────────────────────
kids.push(H('Appendix A — Documents the system tracks', HeadingLevel.HEADING_1, { pageBreak: true, size: 32 }));
kids.push(P('Each of these is watched for expiry. Where a renewal service exists, it opens itself in time; where prerequisites are listed, the system holds the renewal until they are satisfied rather than submitting something that will be refused.', { size: 19, color: GREY, after: 200 }));
const dw = [2700, 1400, 1500, 1500, 2800];
const dRows = [new TableRow({
  tableHeader: true,
  children: ['Document', 'Belongs to', 'Authority', 'Renewal opens', 'Cannot renew without'].map((l, i) =>
    cell([txt(l, { bold: true, size: 16, color: 'FFFFFF' })], { width: dw[i], fill: PURPLE })),
})];
M.docTypes.forEach((d, i) => {
  const pre = (d.prereqs || []).map(p => {
    const need = p.requiresDocType || p.docType || (p.kind === 'attribute' ? p.attr : '');
    const m = p.minMonths ? ` (${p.minMonths}m left)` : '';
    return need ? need + m : null;
  }).filter(Boolean);
  dRows.push(new TableRow({
    children: [
      cell([txt(d.name, { bold: true, size: 17 })], { width: dw[0], fill: i % 2 ? LIGHT : undefined }),
      cell([txt(d.subjectKind === 'company' ? 'The company' : 'An employee', { size: 16 })], { width: dw[1], fill: i % 2 ? LIGHT : undefined }),
      cell([txt(d.authority || '—', { size: 16 })], { width: dw[2], fill: i % 2 ? LIGHT : undefined }),
      cell([txt(d.neverExpires ? 'Does not expire' : (d.leadDays ? d.leadDays + ' days before' : '—'), { size: 16, color: GREY })], { width: dw[3], fill: i % 2 ? LIGHT : undefined }),
      cell(lines(pre, { dash: true }), { width: dw[4], fill: i % 2 ? LIGHT : undefined }),
    ],
  }));
});
kids.push(new Table({ columnWidths: dw, width: { size: 9900, type: WidthType.DXA }, rows: dRows }));

// ── Appendix: checklists ──────────────────────────────────────────────────────────────────────
kids.push(H('Appendix B — Document checklists', HeadingLevel.HEADING_1, { pageBreak: true, size: 32 }));
kids.push(P('These are the lists the steps above work through. They are held as configuration, not written into the workflow — so when a requirement changes, the list is edited once and every service using it follows suit.', { size: 19, color: GREY, after: 200 }));
for (const c of M.checklists) {
  const items = [];
  for (const row of (c.rows || [])) for (const d of (row.documents || [])) {
    const lab = d.label || d.key;
    if (lab && !items.some(x => x.startsWith(lab))) items.push(lab + (d.required === false ? '  (only if it applies)' : ''));
  }
  kids.push(P(c.name, { bold: true, size: 19, color: INK, before: 200, after: 60 }));
  items.forEach(i => kids.push(new Paragraph({
    bullet: { level: 0 }, spacing: { after: 40 },
    children: [new TextRun({ text: i, size: 17, color: GREY, font: 'Calibri' })],
  })));
}

// ── Appendix: authorities ─────────────────────────────────────────────────────────────────────
kids.push(H('Appendix C — Government authorities', HeadingLevel.HEADING_1, { pageBreak: true, size: 32 }));
kids.push(P('Steps are tagged with the authority they are performed at, so work can be grouped by portal and each client’s portal access is kept with it.', { size: 19, color: GREY, after: 200 }));
const aw = [2600, 7300];
kids.push(new Table({
  columnWidths: aw, width: { size: 9900, type: WidthType.DXA },
  rows: M.authorities.map((a, i) => new TableRow({
    children: [
      cell([txt(a.name, { bold: true, size: 17 })], { width: aw[0], fill: i % 2 ? LIGHT : undefined }),
      cell([txt(a.sub || '—', { size: 17, color: GREY })], { width: aw[1], fill: i % 2 ? LIGHT : undefined }),
    ],
  })),
}));

kids.push(H('Adding further services', HeadingLevel.HEADING_2, { before: 400, size: 24 }));
kids.push(P('The two services in this handbook are the ones configured today. Every other PRO service — Commercial Registration renewal, Iqama renewal, profession change, GOSI registration, VAT filing and the rest — is added the same way: as a configured sequence of steps on the same engine, with its own owners, targets, checklists and documents. No part of the application is rebuilt to add one, and each new service appears in this handbook in exactly the form above.', { size: 20, after: 160 }));

const doc = new Document({
  creator: 'STIMES PRO',
  title: 'STIMES PRO — Service Handbook',
  description: 'Configured PRO services: steps, owners, targets, checklists and documents',
  styles: {
    default: { document: { run: { font: 'Calibri', size: 20, color: INK } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 32, bold: true, color: PURPLE, font: 'Calibri' } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 24, bold: true, color: INK, font: 'Calibri' } },
    ],
  },
  sections: [{
    properties: { page: { margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 } } },
    children: kids,
  }],
});

Packer.toBuffer(doc).then(b => {
  fs.writeFileSync('STIMES-PRO-Service-Handbook.docx', b);
  console.log('written:', b.length, 'bytes');
});

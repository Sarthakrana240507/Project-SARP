import Head from 'next/head';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, CartesianGrid,
} from 'recharts';
import { useChartTheme } from '@/lib/theme';
import { getToken, getUser, getAnalytics, getAnalyticsOptions, downloadAnalyticsCsv, downloadAnalyticsPdf } from '@/lib/api';

const NO_FILTERS = { department: 'all', programme: 'all', category: 'all', academic_session: 'all', semester: 'all', status: 'all', date_from: '', date_to: '' };
const STATUS_LABEL = { approved: 'Approved', pending: 'Pending', resubmitted: 'Resubmitted', rejected: 'Rejected', correction_requested: 'Correction requested' };
// what each report choice downloads
const REPORTS = {
  overall: { label: 'Overall', csv: 'activities', pdf: 'institutional', csvName: 'Activity records', pdfName: 'Institutional report' },
  department: { label: 'By department', csv: 'department', pdf: 'department', csvName: 'Department summary', pdfName: 'Department-wise report' },
  semester: { label: 'By semester', csv: 'semester', pdf: 'semester', csvName: 'Semester summary', pdfName: 'Semester-wise report' },
};

export default function Analytics() {
  const chart = useChartTheme();
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [options, setOptions] = useState(null);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState('overall');
  const [exporting, setExporting] = useState('');
  const requestId = useRef(0);

  useEffect(() => {
    const u = getUser();
    if (!getToken() || !u) { router.replace('/login'); return; }
    if (!['faculty', 'admin'].includes(u.role)) { router.replace('/dashboard'); return; }
    setUser(u);
    getAnalyticsOptions().then(setOptions).catch((e) => setError(e.message));
  }, [router]);

  const load = useCallback(async () => {
    const mine = ++requestId.current;
    setLoading(true);
    try {
      const res = await getAnalytics(filters);
      if (mine === requestId.current) { setData(res); setError(''); }
    } catch (e) {
      if (mine === requestId.current) { setData(null); setError(e.message); }
    } finally {
      if (mine === requestId.current) setLoading(false);
    }
  }, [filters]);
  useEffect(() => { if (user) load(); }, [user, load]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const active = Object.entries(filters).filter(([, v]) => v && v !== 'all');
  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 4500); };

  const exportAs = async (kind) => {
    setExporting(kind); setError('');
    try {
      const r = REPORTS[report];
      const name = kind === 'csv' ? await downloadAnalyticsCsv(filters, r.csv) : await downloadAnalyticsPdf(filters, r.pdf);
      flash(`${name} downloaded.`);
    } catch (e) { setError(e.message); } finally { setExporting(''); }
  };

  const tip = {
    itemStyle: { color: chart.tooltipText }, labelStyle: { color: chart.tooltipText }, cursor: { fill: chart.grid, fillOpacity: 0.35 },
    contentStyle: { backgroundColor: chart.tooltipBg, color: chart.tooltipText, borderRadius: '10px', border: 'none', fontSize: '12px' },
  };
  const axis = { tick: { fontSize: 11, fill: chart.axis } };
  const legend = <Legend formatter={(v) => <span className="text-xs font-medium text-ink">{v}</span>} />;
  const C = { approved: chart.series[2], pending: chart.series[5], rejected: chart.series[6], correction: chart.series[1] };
  const stack = [['approved', 'Approved', C.approved], ['pending', 'Pending', C.pending], ['rejected', 'Rejected', C.rejected], ['correction_requested', 'Correction requested', C.correction]];
  const stacked = (rows, key, extra = {}) => (
    <ResponsiveContainer width="100%" height={extra.height || 280}>
      <BarChart data={rows} layout={extra.layout} margin={{ top: 10, right: 12, left: extra.layout ? 20 : -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={!!extra.layout} horizontal={!extra.layout} stroke={chart.grid} />
        {extra.layout ? (<><XAxis type="number" allowDecimals={false} {...axis} /><YAxis type="category" dataKey={key} width={extra.width || 130} {...axis} /></>)
          : (<><XAxis dataKey={key} {...axis} tickFormatter={extra.fmt} /><YAxis allowDecimals={false} {...axis} /></>)}
        <Tooltip {...tip} />
        {legend}
        {stack.map(([k, label, color]) => <Bar key={k} isAnimationActive={false} dataKey={k} name={label} stackId="s" fill={color} />)}
      </BarChart>
    </ResponsiveContainer>
  );
  const simpleBar = (rows, key, color, height = 260) => (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 10, right: 10, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chart.grid} />
        <XAxis dataKey={key} {...axis} /><YAxis allowDecimals={false} {...axis} /><Tooltip {...tip} />
        <Bar isAnimationActive={false} dataKey="count" name="Submissions" radius={[6, 6, 0, 0]} fill={color} />
      </BarChart>
    </ResponsiveContainer>
  );

  if (!user) return null;
  const t = data?.totals;
  const empty = data && t.total_activities === 0;
  const scope = options?.scope;

  return (
    <>
      <Head><title>SARP — Analytics &amp; Reports</title></Head>
      <div className="app-shell">
        <main className="page-wrap">
          <div className="rounded-2xl border border-brand-line bg-gradient-to-r from-brand-soft via-surface to-accent-soft p-6 shadow-sm sm:p-7">
            <p className="eyebrow">Institutional analytics</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink-strong sm:text-3xl">Activity Analytics &amp; Reports</h1>
            <p className="mt-1 text-xs text-ink-secondary sm:text-sm">
              Every figure is calculated from the platform database for the filters below. Drafts are never counted.
              {scope && ` You see students in your verification scope: ${scope.all ? 'all departments' : scope.departments.join(', ') || 'none assigned'}.`}
            </p>
          </div>

          {error && <div className="mt-5 rounded-xl border border-rose-200 bg-danger-soft p-4 text-xs font-semibold text-danger-text" role="alert" data-testid="analytics-error">✕ {error}</div>}

          <section className="card card-pad mt-6" data-testid="analytics-filters">
            <div className="mb-3 flex items-center justify-between border-b border-line-soft pb-3">
              <span className="text-xs font-bold text-ink-strong">Filters {active.length > 0 && <span className="ml-1 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] text-brand-text" data-testid="filter-count">{active.length} active</span>}</span>
              <button type="button" onClick={() => setFilters(NO_FILTERS)} disabled={active.length === 0} className="text-[11px] font-semibold text-brand-text hover:text-ink-strong disabled:opacity-40" data-testid="reset-filters">Reset filters</button>
            </div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
              <Select label="Department" value={filters.department} onChange={set('department')} all="All departments" opts={(options?.departments || []).map((d) => [d, d])} id="f-department" />
              <Select label="Programme" value={filters.programme} onChange={set('programme')} all="All programmes" opts={(options?.programmes || []).map((d) => [d, d])} id="f-programme" />
              <Select label="Category" value={filters.category} onChange={set('category')} all="All categories" opts={(options?.categories || []).map((c) => [c.name, c.display_name])} id="f-category" />
              <Select label="Academic year" value={filters.academic_session} onChange={set('academic_session')} all="All years" opts={(options?.academic_years || []).map((y) => [y, y])} id="f-year" />
              <Select label="Semester" value={filters.semester} onChange={set('semester')} all="All semesters" opts={(options?.semesters || []).map((s) => [String(s), `Semester ${s}`])} id="f-semester" />
              <Select label="Status" value={filters.status} onChange={set('status')} all="All statuses" opts={(options?.statuses || []).map((s) => [s, STATUS_LABEL[s]])} id="f-status" />
              <div>
                <label className="field-label" htmlFor="f-from">Submitted from</label>
                <input id="f-from" type="date" className="field" value={filters.date_from} max={filters.date_to || undefined} onChange={set('date_from')} />
              </div>
              <div>
                <label className="field-label" htmlFor="f-to">Submitted to</label>
                <input id="f-to" type="date" className="field" value={filters.date_to} min={filters.date_from || undefined} onChange={set('date_to')} />
              </div>
            </div>
          </section>

          <section className="card card-pad mt-4" data-testid="report-panel">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="section-title">Download a report</h2>
                <p className="mt-1 text-xs text-ink-secondary">Reports contain exactly the records matching the filters above{active.length ? ` (${active.length} active)` : ' (none set: everything you may see)'}.</p>
                <div className="mt-3 inline-flex flex-wrap gap-1.5" role="radiogroup" aria-label="Report type">
                  {Object.entries(REPORTS).map(([id, r]) => (
                    <button key={id} type="button" role="radio" aria-checked={report === id} onClick={() => setReport(id)} data-testid={`report-${id}`}
                      className={`rounded-xl border px-3.5 py-2 text-xs font-semibold transition ${report === id ? 'border-brand-line bg-brand-soft text-ink-strong' : 'border-line bg-surface text-ink-secondary hover:bg-surface-alt'}`}>{r.label}</button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" onClick={() => exportAs('csv')} disabled={!!exporting} data-testid="export-csv">{exporting === 'csv' ? 'Preparing…' : `CSV · ${REPORTS[report].csvName}`}</button>
                <button type="button" className="btn-primary" onClick={() => exportAs('pdf')} disabled={!!exporting} data-testid="export-pdf">{exporting === 'pdf' ? 'Generating…' : `PDF · ${REPORTS[report].pdfName}`}</button>
              </div>
            </div>
          </section>

          {loading && !data ? (
            <div className="card mt-7 p-14 text-center text-xs font-semibold text-ink-secondary">Loading analytics…</div>
          ) : !data ? null : empty ? (
            <div className="card mt-7 p-12 text-center" data-testid="analytics-empty">
              <p className="text-sm font-bold text-ink-strong">No submissions match these filters</p>
              <p className="mt-1 text-xs text-ink-secondary">{active.length ? 'Try removing a filter or widening the date range.' : 'No activities have been submitted yet.'}</p>
              {active.length > 0 && <button type="button" className="btn-secondary mt-4" onClick={() => setFilters(NO_FILTERS)}>Reset filters</button>}
            </div>
          ) : (
            <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={loading}>
              <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" data-testid="stat-cards">
                <Stat label="Students" value={t.total_students} border="border-l-brand" testId="stat-students" />
                <Stat label="Submissions" value={t.total_activities} border="border-l-navy" testId="stat-total" />
                <Stat label="Approved" value={t.approved} border="border-l-accent" testId="stat-approved" />
                <Stat label="Pending review" value={t.pending} border="border-l-amber-500" testId="stat-pending" />
                <Stat label="Rejected" value={t.rejected} border="border-l-rose-500" testId="stat-rejected" />
                <Stat label="Duplicate flags" value={data.flagged_duplicates} border="border-l-violet-text" testId="stat-duplicates" />
              </div>

              <div className="mt-7 grid gap-6 lg:grid-cols-2">
                <ChartCard title="Approval and rejection" subtitle="Submissions by verification status" testId="chart-status">
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart>
                      <Pie isAnimationActive={false} data={data.by_status.map((s) => ({ ...s, name: STATUS_LABEL[s.status] || s.status }))} dataKey="count" nameKey="name" outerRadius={90} innerRadius={48} paddingAngle={3}>
                        {data.by_status.map((s) => <Cell key={s.status} fill={{ approved: C.approved, pending: C.pending, resubmitted: chart.series[4], rejected: C.rejected, correction_requested: C.correction }[s.status] || chart.series[0]} />)}
                      </Pie>
                      <Tooltip {...tip} />{legend}
                    </PieChart>
                  </ResponsiveContainer>
                </ChartCard>
                <ChartCard title="Category distribution" subtitle="Submissions across categories" testId="chart-category">
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart>
                      <Pie isAnimationActive={false} data={data.by_category} dataKey="count" nameKey="category" outerRadius={90} innerRadius={48} paddingAngle={3}>
                        {data.by_category.map((c, i) => <Cell key={c.category} fill={chart.series[i % chart.series.length]} />)}
                      </Pie>
                      <Tooltip {...tip} />
                      <Legend formatter={(v) => <span className="text-xs font-medium capitalize text-ink">{v}</span>} />
                    </PieChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <ChartCard title="Department-wise participation" subtitle="Submissions by department and outcome" testId="chart-department">
                  {stacked(data.by_department, 'department', { layout: 'vertical', height: Math.max(220, data.by_department.length * 44 + 70), width: 150 })}
                </ChartCard>
                <ChartCard title="Monthly activity trend" subtitle="Submissions per month (latest 12 months with activity)" testId="chart-month">
                  {simpleBar(data.by_month, 'month', chart.series[2])}
                </ChartCard>
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <ChartCard title="Semester-wise statistics" subtitle="Outcome of submissions in each semester" testId="chart-semester" emptyText="No semester recorded for these submissions.">
                  {data.by_semester.length > 0 && stacked(data.by_semester.map((r) => ({ ...r, label: `Sem ${r.semester}` })), 'label')}
                </ChartCard>
                <ChartCard title="Academic year comparison" subtitle="Outcome of submissions in each academic year" testId="chart-year" emptyText="No academic year recorded for these submissions.">
                  {data.by_academic_year.length > 0 && stacked(data.by_academic_year, 'academic_session')}
                </ChartCard>
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <ChartCard title="Pending submission trend" subtitle="Submissions still awaiting review, by month submitted" testId="chart-pending" emptyText="Nothing is waiting for review.">
                  {data.pending_by_month.length > 0 && simpleBar(data.pending_by_month, 'month', chart.series[5])}
                </ChartCard>
                <ChartCard title="Faculty verification workload" subtitle={user.role === 'admin' ? 'Reviews completed by each faculty member (latest decision on each submission)' : 'Reviews you completed (latest decision on each submission)'} testId="chart-workload" emptyText="No reviews have been completed for these filters.">
                  {data.faculty_workload.length > 0 && stacked(data.faculty_workload, 'name', { layout: 'vertical', height: Math.max(200, data.faculty_workload.length * 44 + 70), width: 150 })}
                </ChartCard>
              </div>
            </div>
          )}
        </main>
        {toast && <div className="toast" role="status"><span className="font-bold text-accent-text">✓</span><span>{toast}</span></div>}
      </div>
    </>
  );
}

function Select({ label, value, onChange, all, opts, id }) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <select id={id} className="field" value={value} onChange={onChange}>
        <option value="all">{all}</option>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}
function Stat({ label, value, border, testId }) {
  return (
    <div className={`stat-card border-l-4 ${border}`} data-testid={testId}>
      <p className="text-2xl font-bold tracking-tight text-ink-strong">{value}</p>
      <p className="mt-1 text-[11px] font-bold uppercase tracking-wider text-ink-secondary">{label}</p>
    </div>
  );
}
function ChartCard({ title, subtitle, children, testId, emptyText = 'Nothing to show for these filters.' }) {
  const hasContent = children && (!Array.isArray(children) || children.some(Boolean));
  return (
    <section className="card card-pad" data-testid={testId}>
      <h2 className="section-title text-sm">{title}</h2>
      <p className="mt-0.5 text-xs text-ink-secondary">{subtitle}</p>
      <div className="mt-5">{hasContent && children !== false ? children : <div className="flex h-[200px] items-center justify-center text-xs font-semibold text-ink-secondary" data-testid={`${testId}-empty`}>{emptyText}</div>}</div>
    </section>
  );
}

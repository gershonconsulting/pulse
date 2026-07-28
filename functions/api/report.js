// functions/api/report.js
// POST /api/report — generate and optionally email a Pulse report
// Sends to report@gershonconsulting.com with subject "[Platform] Report — [Date Range]"
// Requires RESEND_API_KEY env var for email delivery

import { json, readData } from './_shared.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const data = await readData(env.PULSE_KV);
    const now = new Date();

    // Compute stats
    const red = data.messages.filter(m => m.status === 'Red');
    const orange = data.messages.filter(m => m.status === 'Orange');
    const green = data.messages.filter(m => m.status === 'Green');
    const total = data.messages.length;

    // Source breakdown
    const linkedinMessages = data.messages.filter(m => m.source === 'linkedin-messaging' || !m.source);
    const salesNavMessages = data.messages.filter(m => m.source === 'sales-navigator');

    // Last scan info
    const lastScan = data.scans.length > 0 ? data.scans[0] : null;
    const lastScanTime = lastScan ? new Date(lastScan.timestamp) : null;

    // Recent transitions (last 7 days)
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    let recentTransitions = [];
    for (const m of data.messages) {
      if (m.statusHistory) {
        for (const h of m.statusHistory) {
          if (new Date(h.timestamp) > weekAgo) {
            recentTransitions.push({ name: m.name, ...h });
          }
        }
      }
    }

    // Progress stats
    let treatedCount = 0;
    let regressedCount = 0;
    for (const m of data.messages) {
      if (m.statusHistory) {
        for (const h of m.statusHistory) {
          if (h.from === 'Red' && (h.to === 'Green' || h.to === 'Orange')) treatedCount++;
          if ((h.from === 'Green' || h.from === 'Orange') && h.to === 'Red') regressedCount++;
        }
      }
    }

    // Top campaigns
    const campaignCounts = {};
    for (const m of data.messages) {
      if (m.campaign) {
        campaignCounts[m.campaign] = (campaignCounts[m.campaign] || 0) + 1;
      }
    }
    const topCampaigns = Object.entries(campaignCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // Hot leads (Red with recent activity)
    const hotLeads = red
      .filter(m => m.snippet && m.snippet.length > 10)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .slice(0, 10);

    // Date range for subject
    const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const weekAgoStr = weekAgo.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    const dateRange = `${weekAgoStr} – ${dateStr}`;

    // Build report
    const report = {
      generatedAt: now.toISOString(),
      dateRange,
      trigger: body.trigger || 'manual',
      summary: {
        total,
        red: red.length,
        orange: orange.length,
        green: green.length,
        linkedinMessaging: linkedinMessages.length,
        salesNavigator: salesNavMessages.length,
      },
      progress: {
        treatedCount,
        regressedCount,
        recentTransitions: recentTransitions.length,
      },
      topCampaigns,
      hotLeads: hotLeads.map(m => ({
        name: m.name,
        snippet: (m.snippet || '').substring(0, 150),
        campaign: m.campaign,
        source: m.source || 'linkedin-messaging',
        updatedAt: m.updatedAt,
      })),
      lastScan: lastScan ? {
        timestamp: lastScan.timestamp,
        count: lastScan.count,
        source: lastScan.source,
      } : null,
    };

    // Generate HTML email
    const htmlEmail = generateEmailHtml(report);

    // Send email if RESEND_API_KEY is configured
    let emailSent = false;
    let emailError = null;

    if (env.RESEND_API_KEY) {
      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: env.EMAIL_FROM || 'Pulse <pulse@gershoncrm.com>',
            to: [env.REPORT_EMAIL || 'report@gershonconsulting.com'],
            subject: `Pulse LinkedIn Report — ${dateRange}`,
            html: htmlEmail,
          }),
        });

        if (emailRes.ok) {
          emailSent = true;
        } else {
          const errData = await emailRes.json().catch(() => ({}));
          emailError = errData.message || `HTTP ${emailRes.status}`;
        }
      } catch (err) {
        emailError = err.message;
      }
    } else {
      emailError = 'RESEND_API_KEY not configured — report generated but not emailed';
    }

    return json({
      success: true,
      report,
      email: {
        sent: emailSent,
        error: emailError,
        recipient: env.REPORT_EMAIL || 'report@gershonconsulting.com',
        subject: `Pulse LinkedIn Report — ${dateRange}`,
      },
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// GET /api/report — return the latest report without sending email
export async function onRequestGet({ env }) {
  try {
    const data = await readData(env.PULSE_KV);
    const now = new Date();
    const red = data.messages.filter(m => m.status === 'Red');
    const orange = data.messages.filter(m => m.status === 'Orange');
    const green = data.messages.filter(m => m.status === 'Green');

    return json({
      generatedAt: now.toISOString(),
      total: data.messages.length,
      red: red.length,
      orange: orange.length,
      green: green.length,
      lastScan: data.scans.length > 0 ? data.scans[0] : null,
      hotLeads: red
        .filter(m => m.snippet && m.snippet.length > 10)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, 10)
        .map(m => ({ name: m.name, snippet: (m.snippet || '').substring(0, 100), campaign: m.campaign })),
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function generateEmailHtml(report) {
  const { summary, progress, topCampaigns, hotLeads, dateRange, lastScan } = report;

  const campaignRows = topCampaigns.map(([code, count]) =>
    `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;font-weight:600;">${code}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center;">${count}</td></tr>`
  ).join('');

  const hotLeadRows = hotLeads.map(lead =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">
        <strong>${escHtml(lead.name)}</strong>${lead.campaign ? ` <span style="color:#6b7280;font-size:12px;">(${lead.campaign})</span>` : ''}
        <br><span style="color:#6b7280;font-size:13px;">${escHtml(lead.snippet)}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;font-size:12px;color:#6b7280;">
        ${lead.source === 'sales-navigator' ? 'SN' : 'LI'}
      </td>
    </tr>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#0077b5,#005885);color:white;padding:24px;border-radius:12px 12px 0 0;">
      <h1 style="margin:0;font-size:24px;">Pulse LinkedIn Report</h1>
      <p style="margin:4px 0 0;opacity:0.85;font-size:14px;">${dateRange}</p>
    </div>

    <!-- Summary Cards -->
    <div style="background:white;padding:20px;border-bottom:1px solid #e5e7eb;">
      <h2 style="margin:0 0 12px;font-size:16px;color:#374151;">Pipeline Overview</h2>
      <table width="100%" style="border-collapse:collapse;">
        <tr>
          <td style="text-align:center;padding:12px;background:#fef2f2;border-radius:8px;">
            <div style="font-size:28px;font-weight:700;color:#dc2626;">${summary.red}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;">Need Action</div>
          </td>
          <td style="width:8px;"></td>
          <td style="text-align:center;padding:12px;background:#fffbeb;border-radius:8px;">
            <div style="font-size:28px;font-weight:700;color:#d97706;">${summary.orange}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;">No Action</div>
          </td>
          <td style="width:8px;"></td>
          <td style="text-align:center;padding:12px;background:#f0fdf4;border-radius:8px;">
            <div style="font-size:28px;font-weight:700;color:#16a34a;">${summary.green}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;">You Sent Last</div>
          </td>
          <td style="width:8px;"></td>
          <td style="text-align:center;padding:12px;background:#eff6ff;border-radius:8px;">
            <div style="font-size:28px;font-weight:700;color:#2563eb;">${summary.total}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;">Total</div>
          </td>
        </tr>
      </table>
      <p style="margin:12px 0 0;font-size:12px;color:#9ca3af;">
        Sources: LinkedIn Messaging (${summary.linkedinMessaging}) · Sales Navigator (${summary.salesNavigator})
      </p>
    </div>

    <!-- Progress -->
    <div style="background:white;padding:20px;border-bottom:1px solid #e5e7eb;">
      <h2 style="margin:0 0 12px;font-size:16px;color:#374151;">Progress</h2>
      <p style="margin:0;font-size:14px;color:#374151;">
        <span style="color:#16a34a;font-weight:600;">${progress.treatedCount} treated</span> ·
        <span style="color:#dc2626;font-weight:600;">${progress.regressedCount} need attention again</span> ·
        <span style="color:#6b7280;">${progress.recentTransitions} changes this week</span>
      </p>
    </div>

    ${topCampaigns.length > 0 ? `
    <!-- Campaigns -->
    <div style="background:white;padding:20px;border-bottom:1px solid #e5e7eb;">
      <h2 style="margin:0 0 12px;font-size:16px;color:#374151;">Top Campaigns</h2>
      <table width="100%" style="border-collapse:collapse;font-size:14px;">
        <tr style="background:#f8f9fa;">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;">Campaign</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#6b7280;">Conversations</th>
        </tr>
        ${campaignRows}
      </table>
    </div>` : ''}

    ${hotLeads.length > 0 ? `
    <!-- Hot Leads -->
    <div style="background:white;padding:20px;border-bottom:1px solid #e5e7eb;">
      <h2 style="margin:0 0 12px;font-size:16px;color:#dc2626;">Hot Leads (Action Needed)</h2>
      <table width="100%" style="border-collapse:collapse;font-size:14px;">
        ${hotLeadRows}
      </table>
    </div>` : ''}

    <!-- Footer -->
    <div style="background:white;padding:16px 20px;border-radius:0 0 12px 12px;text-align:center;">
      <a href="https://pulse.gershoncrm.com" style="color:#0077b5;text-decoration:none;font-weight:600;font-size:14px;">
        Open Pulse Dashboard →
      </a>
      <p style="margin:8px 0 0;font-size:11px;color:#9ca3af;">
        ${lastScan ? `Last sync: ${new Date(lastScan.timestamp).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : 'No sync data'}
        · Generated by Pulse v4.1.0
      </p>
    </div>
  </div>
</body>
</html>`;
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

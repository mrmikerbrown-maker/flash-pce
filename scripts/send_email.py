"""Email the latest Flash PCE estimate (run by the workflow only when the page was updated).
Uses the same Gmail setup as Mike's market alert emails: secrets SENDER, RECIPIENT, APP_PASSWORD."""
import json, os, smtplib, sys
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

SITE = 'https://mrmikerbrown-maker.github.io/flash-pce/'
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
          'October', 'November', 'December']


def month(ym):
    return f"{MONTHS[int(ym[5:7]) - 1]} {ym[:4]}"


def sgn(v):
    return '' if v is None else f"{v:+.1f}"


def main():
    sender, recipient, pw = (os.environ.get(k) for k in ('SENDER', 'RECIPIENT', 'APP_PASSWORD'))
    if not (sender and recipient and pw):
        print('Email secrets not set; skipping email.')
        return
    d = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'docs', 'data.json')))
    status = {'final': 'Final', 'provisional': 'Provisional', 'waiting': 'Waiting for data'}[d['status']]
    inputs = ('CPI and PPI in' if d['cpiIn'] and d['ppiIn'] else 'CPI in, PPI to come' if d['cpiIn']
              else 'PPI in, CPI to come' if d['ppiIn'] else 'no CPI or PPI yet')
    c, h = d['core'], d['headline']
    morning = '--morning' in sys.argv
    subject = f"Flash PCE {month(d['target'])}: core {c['mom']:.2f}%, headline {h['mom']:.2f}% ({status.lower()})"
    if morning:
        subject = f"PCE today: Flash PCE sees core {c['mom']:.2f}%, headline {h['mom']:.2f}% for {month(d['target'])}"
    warns = d.get('newWarnings') or []
    if morning:
        warns = []
    if warns:
        subject = '[Check data] ' + subject

    groups = ['Core services ex housing', 'Housing', 'Core goods', 'Food', 'Energy']
    grows = ''.join(f"<tr><td style='padding:3px 12px 3px 0'>{g}</td><td align='right'>{sgn(d['groups'].get(g))}</td></tr>"
                    for g in groups)
    top = sorted(d['lines'], key=lambda l: -abs(l['headBp'] or 0))[:8]
    lrows = ''.join(f"<tr><td style='padding:3px 12px 3px 0'>{l['name']}</td><td align='right'>{l['mom']:.2f}</td>"
                    f"<td align='right' style='padding-left:12px'>{sgn(l['headBp'])}</td></tr>" for l in top)
    st = d['backtest']['stats']
    warn_html = ('<div style="border:1px solid #B23A48;background:#FBEFF1;color:#7A1F2C;padding:10px 12px;margin:0 0 14px;font-size:14px">'
                 '<b>Data check needed.</b> The affected lines are using a fallback until this is fixed:<br>' + '<br>'.join(warns) + '</div>') if warns else ''
    html = f"""<div style="font-family:Arial,sans-serif;color:#0E1620;max-width:560px">
<p style="font-family:Georgia,serif;font-size:22px;color:#071B35;margin:0 0 4px">Flash PCE: {month(d['target'])}</p>
<p style="color:#59616A;margin:0 0 14px">{'Official ' + month(d['target']) + ' PCE is out today at 13:30 UK. Model projection:' if morning else status + ' &middot; ' + inputs}</p>
{warn_html}
<table style="border-collapse:collapse;font-size:15px;margin-bottom:14px">
<tr><td></td><td style="padding:0 12px;color:#59616A">m/m</td><td style="padding:0 12px;color:#59616A">annualised</td><td style="padding:0 12px;color:#59616A">implied y/y</td></tr>
<tr><td><b>Core PCE</b></td><td style="padding:2px 12px"><b>{c['mom']:.2f}%</b></td><td style="padding:2px 12px">{c['ann']:.1f}%</td><td style="padding:2px 12px">{c['yoy']:.2f}%</td></tr>
<tr><td><b>Headline PCE</b></td><td style="padding:2px 12px"><b>{h['mom']:.2f}%</b></td><td style="padding:2px 12px">{h['ann']:.1f}%</td><td style="padding:2px 12px">{h['yoy']:.2f}%</td></tr>
</table>
<p style="margin:0 0 4px;color:#59616A">Contribution to headline, bp</p>
<table style="border-collapse:collapse;font-size:14px;margin-bottom:14px">{grows}</table>
<p style="margin:0 0 4px;color:#59616A">Biggest lines (m/m %, headline bp)</p>
<table style="border-collapse:collapse;font-size:14px;margin-bottom:14px">{lrows}</table>
<p style="color:#59616A;font-size:13px">Backtest, last 24 months: core average miss {st['coreMae']:.1f}bp, headline {st['headMae']:.1f}bp.
{'' if morning else 'Official PCE due ' + (d['nextReleases'].get('PCE') or 'n/a') + '.'}</p>
<p><a href="{SITE}" style="color:#071B35">Open the full page</a></p></div>"""

    msg = MIMEMultipart('alternative')
    msg['Subject'], msg['From'], msg['To'] = subject, sender, recipient
    msg.attach(MIMEText(f"{subject}\n{SITE}", 'plain'))
    msg.attach(MIMEText(html, 'html'))
    with smtplib.SMTP('smtp.gmail.com', 587) as s:
        s.starttls()
        s.login(sender, pw)
        s.sendmail(sender, [r.strip() for r in recipient.split(',')], msg.as_string())
    print('Email sent:', subject)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # runs after the page is published, so a failure here only flags the email
        print('Email failed:', e, file=sys.stderr)
        sys.exit(1)

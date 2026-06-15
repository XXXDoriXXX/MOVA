// Friendly branded verification email — table-based so it survives Gmail/Outlook.
export function verificationEmailHtml(link: string): string {
  return `<!doctype html>
<html lang="uk"><body style="margin:0;padding:0;background:#0E1116;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0E1116;padding:32px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;">
        <tr><td style="background:#0E1116;padding:26px 32px;">
          <span style="color:#ffffff;font-size:26px;font-weight:800;letter-spacing:-0.5px;">Mova</span>
        </td></tr>
        <tr><td style="padding:34px 32px 8px;">
          <h1 style="margin:0 0 14px;font-size:22px;color:#0E1116;">Вітаємо в Mova&nbsp;👋</h1>
          <p style="margin:0 0 26px;font-size:15px;line-height:1.55;color:#444444;">
            Залишився один крок — підтвердіть свою пошту, щоб почати користуватися застосунком.
          </p>
          <a href="${link}" style="display:inline-block;background:#0E1116;color:#ffffff;text-decoration:none;padding:15px 30px;border-radius:12px;font-weight:700;font-size:15px;">
            Підтвердити пошту
          </a>
        </td></tr>
        <tr><td style="padding:22px 32px 34px;">
          <p style="margin:0;font-size:13px;line-height:1.5;color:#9aa0a6;">
            Кнопка не працює? Скопіюйте посилання:<br/>
            <a href="${link}" style="color:#5b6b7a;word-break:break-all;">${link}</a>
          </p>
          <p style="margin:18px 0 0;font-size:12px;color:#b3b8bd;">
            Посилання дійсне 24 години. Якщо ви не реєструвалися в Mova — просто проігноруйте цей лист.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

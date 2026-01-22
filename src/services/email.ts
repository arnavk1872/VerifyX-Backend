import * as brevo from '@getbrevo/brevo';

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply.verifyx@gmail.com';
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'VerifyX';

if (!BREVO_API_KEY) {
  console.warn('BREVO_API_KEY not set - emails will be logged to console only');
}

let brevoClient: brevo.TransactionalEmailsApi | null = null;

if (BREVO_API_KEY) {
  brevoClient = new brevo.TransactionalEmailsApi();
  (brevoClient as any).authentications.apiKey.apiKey = BREVO_API_KEY;
}

export async function sendPasswordResetCode(email: string, code: string): Promise<void> {
  const emailFrom = EMAIL_FROM;
  const emailFromName = EMAIL_FROM_NAME;

  if (!brevoClient) {
    console.log(`[EMAIL] Password reset code for ${email}`);
    console.log(`[EMAIL] From: ${emailFromName} <${emailFrom}>`);
    console.log(`[EMAIL] To: ${email}`);
    console.log(`[EMAIL] Code: ${code}`);
    console.log(`[EMAIL] Expires in: 15 minutes`);
    return;
  }

  try {
    const sendSmtpEmail = new brevo.SendSmtpEmail();
    sendSmtpEmail.sender = { name: emailFromName, email: emailFrom };
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = 'VerifyX - Password Reset Code';
    sendSmtpEmail.htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Password Reset Request</h2>
        <p>You requested a password reset for your VerifyX account.</p>
        <p style="font-size: 24px; font-weight: bold; color: #007bff; letter-spacing: 4px; text-align: center; padding: 20px; background: #f5f5f5; border-radius: 8px; margin: 20px 0;">
          ${code}
        </p>
        <p>This code will expire in 15 minutes.</p>
        <p>If you didn't request this, please ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #666; font-size: 12px;">VerifyX - KYC Platform</p>
      </div>
    `;
    sendSmtpEmail.textContent = `Your password reset code is: ${code}\n\nThis code will expire in 15 minutes.\n\nIf you didn't request this, please ignore this email.`;

    const response = await brevoClient.sendTransacEmail(sendSmtpEmail);
    console.log(`[EMAIL] Password reset code sent to ${email}`);
    console.log(`[EMAIL] Message ID: ${response.body?.messageId || 'N/A'}`);
    console.log(`[EMAIL] Status: ${response.response?.statusCode || 'N/A'}`);
    
    if (response.response?.statusCode === 201) {
      console.log(`[EMAIL] ✅ Email accepted by Brevo. Check:`);
      console.log(`[EMAIL] 1. Brevo Dashboard → Statistics → Emails (check delivery status)`);
      console.log(`[EMAIL] 2. Spam folder`);
      console.log(`[EMAIL] 3. Sender email (${emailFrom}) must be verified in Brevo`);
    }
  } catch (error: any) {
    console.error('[EMAIL] Failed to send password reset code');
    console.error('[EMAIL] Error details:', error);
    console.error('[EMAIL] Error message:', error.message);
    console.error('[EMAIL] Error response:', error.response?.body || error.body);
    throw new Error('Failed to send password reset email');
  }
}


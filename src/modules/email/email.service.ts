import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import * as handlebars from "handlebars";
import * as fs from "fs";
import * as path from "path";

const getFrontendUrl = (): string => {
  const raw = process.env.FRONTEND_URL?.trim();
  if (!raw) {
    return "https://system.2n5global.com";
  }
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
};

const getCompanyName = (): string =>
  process.env.COMPANY_NAME?.trim() || "2N5 Global";

const getHealthAlertCopy = (language: string, companyName: string) => {
  const lang = (language || "en").toLowerCase();

  if (lang === "pt" || lang.startsWith("pt-")) {
    return {
      subject: `Alerta de saúde do WhatsApp - ${companyName}`,
      alertBadge: "Alerta de Saúde",
      greeting: "Olá",
      intro: `Detectamos um problema com uma sessão do WhatsApp vinculada à sua conta na ${companyName}. Sua sessão do WhatsApp pode não estar funcionando corretamente e requer atenção imediata.`,
      alertTitle: "⚠️ Problema Detectado",
      alertMessage:
        "Sua sessão do WhatsApp falhou em várias verificações de saúde consecutivas. Isso pode significar que sua conta foi desconectada, bloqueada ou está enfrentando problemas de conectividade.",
      detailsTitle: "Detalhes da Sessão",
      sessionLabel: "ID da Sessão",
      phoneLabel: "Número de Telefone",
      nameLabel: "Nome do WhatsApp",
      statusLabel: "Status Atual",
      failuresLabel: "Falhas Consecutivas",
      reasonLabel: "Motivo do Erro",
      actionTitle: "Ações Recomendadas",
      action1:
        "Faça login no painel para verificar o status da sua sessão do WhatsApp",
      action2: "Reconecte sua conta do WhatsApp se necessário",
      action3:
        "Verifique se sua conta do WhatsApp não foi bloqueada ou suspensa",
      buttonLabel: "Acessar Painel",
      supportText:
        "Se você precisar de ajuda ou tiver dúvidas, nossa equipe de suporte está disponível para ajudá-lo.",
      footerText: "Atenciosamente,",
      team: `Equipe ${companyName}`,
    };
  }

  if (lang === "es" || lang.startsWith("es-")) {
    return {
      subject: `Alerta de salud de WhatsApp - ${companyName}`,
      alertBadge: "Alerta de Salud",
      greeting: "Hola",
      intro: `Detectamos un problema con una sesión de WhatsApp vinculada a su cuenta en ${companyName}. Su sesión de WhatsApp puede no estar funcionando correctamente y requiere atención inmediata.`,
      alertTitle: "⚠️ Problema Detectado",
      alertMessage:
        "Su sesión de WhatsApp ha fallado en varias verificaciones de salud consecutivas. Esto puede significar que su cuenta ha sido desconectada, bloqueada o está experimentando problemas de conectividad.",
      detailsTitle: "Detalles de la Sesión",
      sessionLabel: "ID de Sesión",
      phoneLabel: "Número de Teléfono",
      nameLabel: "Nombre de WhatsApp",
      statusLabel: "Estado Actual",
      failuresLabel: "Fallos Consecutivos",
      reasonLabel: "Motivo del Error",
      actionTitle: "Acciones Recomendadas",
      action1:
        "Inicie sesión en el panel para verificar el estado de su sesión de WhatsApp",
      action2: "Reconecte su cuenta de WhatsApp si es necesario",
      action3:
        "Verifique si su cuenta de WhatsApp no ha sido bloqueada o suspendida",
      buttonLabel: "Acceder al Panel",
      supportText:
        "Si necesita ayuda o tiene preguntas, nuestro equipo de soporte está disponible para ayudarle.",
      footerText: "Atentamente,",
      team: `Equipo ${companyName}`,
    };
  }

  if (lang === "fr" || lang.startsWith("fr-")) {
    return {
      subject: `Alerte de santé WhatsApp - ${companyName}`,
      alertBadge: "Alerte de Santé",
      greeting: "Bonjour",
      intro: `Nous avons détecté un problème avec une session WhatsApp liée à votre compte sur ${companyName}. Votre session WhatsApp peut ne pas fonctionner correctement et nécessite une attention immédiate.`,
      alertTitle: "⚠️ Problème Détecté",
      alertMessage:
        "Votre session WhatsApp a échoué à plusieurs vérifications de santé consécutives. Cela peut signifier que votre compte a été déconnecté, bloqué ou rencontre des problèmes de connectivité.",
      detailsTitle: "Détails de la Session",
      sessionLabel: "ID de Session",
      phoneLabel: "Numéro de Téléphone",
      nameLabel: "Nom WhatsApp",
      statusLabel: "Statut Actuel",
      failuresLabel: "Échecs Consécutifs",
      reasonLabel: "Raison de l'Erreur",
      actionTitle: "Actions Recommandées",
      action1:
        "Connectez-vous au tableau de bord pour vérifier l'état de votre session WhatsApp",
      action2: "Reconnectez votre compte WhatsApp si nécessaire",
      action3:
        "Vérifiez si votre compte WhatsApp n'a pas été bloqué ou suspendu",
      buttonLabel: "Accéder au Tableau de Bord",
      supportText:
        "Si vous avez besoin d'aide ou avez des questions, notre équipe de support est disponible pour vous aider.",
      footerText: "Cordialement,",
      team: `Équipe ${companyName}`,
    };
  }

  if (lang === "de" || lang.startsWith("de-")) {
    return {
      subject: `WhatsApp-Gesundheitsalarm - ${companyName}`,
      alertBadge: "Gesundheitsalarm",
      greeting: "Hallo",
      intro: `Wir haben ein Problem mit einer WhatsApp-Sitzung festgestellt, die mit Ihrem Konto auf ${companyName} verknüpft ist. Ihre WhatsApp-Sitzung funktioniert möglicherweise nicht ordnungsgemäß und erfordert sofortige Aufmerksamkeit.`,
      alertTitle: "⚠️ Problem Erkannt",
      alertMessage:
        "Ihre WhatsApp-Sitzung ist bei mehreren aufeinanderfolgenden Gesundheitsprüfungen fehlgeschlagen. Dies kann bedeuten, dass Ihr Konto getrennt, blockiert wurde oder Verbindungsprobleme aufweist.",
      detailsTitle: "Sitzungsdetails",
      sessionLabel: "Sitzungs-ID",
      phoneLabel: "Telefonnummer",
      nameLabel: "WhatsApp-Name",
      statusLabel: "Aktueller Status",
      failuresLabel: "Aufeinanderfolgende Fehler",
      reasonLabel: "Fehlergrund",
      actionTitle: "Empfohlene Maßnahmen",
      action1:
        "Melden Sie sich im Dashboard an, um den Status Ihrer WhatsApp-Sitzung zu überprüfen",
      action2: "Verbinden Sie Ihr WhatsApp-Konto bei Bedarf erneut",
      action3:
        "Überprüfen Sie, ob Ihr WhatsApp-Konto nicht blockiert oder gesperrt wurde",
      buttonLabel: "Zum Dashboard",
      supportText:
        "Wenn Sie Hilfe benötigen oder Fragen haben, steht Ihnen unser Support-Team zur Verfügung.",
      footerText: "Mit freundlichen Grüßen,",
      team: `${companyName}-Team`,
    };
  }

  // Default to English
  return {
    subject: `WhatsApp Health Alert - ${companyName}`,
    alertBadge: "Health Alert",
    greeting: "Hello",
    intro: `We detected an issue with a WhatsApp session linked to your account on ${companyName}. Your WhatsApp session may not be functioning properly and requires immediate attention.`,
    alertTitle: "⚠️ Issue Detected",
    alertMessage:
      "Your WhatsApp session has failed multiple consecutive health checks. This may mean your account has been disconnected, blocked, or is experiencing connectivity issues.",
    detailsTitle: "Session Details",
    sessionLabel: "Session ID",
    phoneLabel: "Phone Number",
    nameLabel: "WhatsApp Name",
    statusLabel: "Current Status",
    failuresLabel: "Consecutive Failures",
    reasonLabel: "Error Reason",
    actionTitle: "Recommended Actions",
    action1: "Log in to the dashboard to check your WhatsApp session status",
    action2: "Reconnect your WhatsApp account if necessary",
    action3:
      "Verify that your WhatsApp account has not been blocked or suspended",
    buttonLabel: "Access Dashboard",
    supportText:
      "If you need assistance or have any questions, our support team is available to help you.",
    footerText: "Best regards,",
    team: `${companyName} Team`,
  };
};

const getUserInvitationCopy = (language: string, companyName: string) => {
  const lang = (language || "en").toLowerCase();

  if (lang === "pt" || lang.startsWith("pt-")) {
    return {
      subject: `Bem-vindo à ${companyName} - Conecte seu WhatsApp`,
      greeting: "Olá",
      invitationIntro: `Você foi convidado(a) para acessar a plataforma ${companyName}. Clique no botão abaixo para abrir um QR Code ativo do WhatsApp quando estiver pronto(a) para conectar.`,
      buttonLabel: "Abrir QR Code em tempo real",
      buttonHelpText:
        "Um novo QR Code será gerado assim que você abrir este link. Use-o imediatamente antes que ele expire.",
      instructionsTitle: "Instruções",
      instruction1: "Abra o WhatsApp no seu celular",
      instruction2: "Toque em Menu ou Configurações e selecione WhatsApp Web",
      instruction3:
        "Aponte a câmera do celular para esta tela para capturar o QR Code",
      instruction4: "Sua conta do WhatsApp será conectada automaticamente",
      warningTitle: "Observações importantes",
      warning1: "Este QR Code é válido por apenas 1 minuto",
      warning2: "Cada QR Code só pode ser usado uma vez",
      warning3: "Certifique-se de usar o aplicativo oficial do WhatsApp",
      supportText:
        "Se você tiver qualquer dúvida ou precisar de ajuda, entre em contato com nossa equipe de suporte.",
    };
  }

  return {
    subject: `Welcome to ${companyName} - Connect Your WhatsApp`,
    greeting: "Hi",
    invitationIntro: `You've been invited to join the ${companyName} platform. Click the button below to open a live WhatsApp QR code whenever you're ready to connect.`,
    buttonLabel: "Open Live QR Code",
    buttonHelpText:
      "A new QR code will be generated the moment you open this link. Use it right away before it expires.",
    instructionsTitle: "Instructions",
    instruction1: "Open WhatsApp on your phone",
    instruction2: "Tap Menu or Settings and select WhatsApp Web",
    instruction3: "Point your phone at this screen to capture the QR code",
    instruction4: "Your WhatsApp account will be connected automatically",
    warningTitle: "Important Notes",
    warning1: "This QR code is typically valid for about 1 minute",
    warning2: "Each QR code can only be used once",
    warning3: "Make sure you're using the official WhatsApp application",
    supportText:
      "If you have any questions or need assistance, please contact our support team.",
  };
};

const getManagerInvitationCopy = (language: string, companyName: string) => {
  const lang = (language || "en").toLowerCase();

  if (lang === "pt" || lang.startsWith("pt-")) {
    return {
      subject: `Bem-vindo à ${companyName} - Acesso de Gerente`,
      emailTitle: `Convite de Acesso de Gerente - ${companyName}`,
      greeting: "Olá",
      intro: `Você recebeu acesso de Gerente à plataforma ${companyName}. Use as credenciais abaixo para entrar na sua conta.`,
      credentialsTitle: "Suas credenciais de acesso",
      labelEmail: "Email:",
      labelTempPassword: "Senha temporária:",
      labelEntity: "Entidade:",
      buttonLabel: "Acessar o painel",
      securityTitle: "Aviso de segurança",
      securityText:
        "Para sua segurança, altere sua senha temporária imediatamente após o primeiro login. Esta senha expirará em 7 dias.",
      helpText:
        "Se você tiver dúvidas ou precisar de ajuda, entre em contato com nossa equipe de suporte.",
      footerNeedHelp:
        "Precisa de ajuda? Entre em contato com nossa equipe de suporte:",
      websiteLabel: "Site",
      linkedinLabel: "LinkedIn",
      twitterLabel: "Twitter",
    };
  }

  if (lang === "es" || lang.startsWith("es-")) {
    return {
      subject: `Bienvenido a ${companyName} - Acceso de Manager`,
      emailTitle: `Invitación de acceso de Manager - ${companyName}`,
      greeting: "Hola",
      intro: `Se le ha concedido acceso de Manager a la plataforma ${companyName}. Use las credenciales a continuación para iniciar sesión.`,
      credentialsTitle: "Sus credenciales de acceso",
      labelEmail: "Correo:",
      labelTempPassword: "Contraseña temporal:",
      labelEntity: "Entidad:",
      buttonLabel: "Acceder al panel",
      securityTitle: "Aviso de seguridad",
      securityText:
        "Por su seguridad, cambie su contraseña temporal inmediatamente después del primer inicio de sesión. Esta contraseña expirará en 7 días.",
      helpText:
        "Si tiene preguntas o necesita ayuda, póngase en contacto con nuestro equipo de soporte.",
      footerNeedHelp:
        "¿Necesita ayuda? Contacte con nuestro equipo de soporte:",
      websiteLabel: "Sitio web",
      linkedinLabel: "LinkedIn",
      twitterLabel: "Twitter",
    };
  }

  if (lang === "fr" || lang.startsWith("fr-")) {
    return {
      subject: `Bienvenue sur ${companyName} - Accès Manager`,
      emailTitle: `Invitation d'accès Manager - ${companyName}`,
      greeting: "Bonjour",
      intro: `Vous avez reçu un accès Manager à la plateforme ${companyName}. Utilisez les identifiants ci-dessous pour vous connecter.`,
      credentialsTitle: "Vos identifiants de connexion",
      labelEmail: "Email :",
      labelTempPassword: "Mot de passe temporaire :",
      labelEntity: "Entité :",
      buttonLabel: "Accéder au tableau de bord",
      securityTitle: "Avis de sécurité",
      securityText:
        "Pour votre sécurité, veuillez changer votre mot de passe temporaire immédiatement après votre première connexion. Ce mot de passe expirera dans 7 jours.",
      helpText:
        "Si vous avez des questions ou besoin d'aide, veuillez contacter notre équipe de support.",
      footerNeedHelp: "Besoin d'aide ? Contactez notre équipe de support :",
      websiteLabel: "Site",
      linkedinLabel: "LinkedIn",
      twitterLabel: "Twitter",
    };
  }

  if (lang === "de" || lang.startsWith("de-")) {
    return {
      subject: `Willkommen bei ${companyName} - Manager-Zugang`,
      emailTitle: `Einladung zum Manager-Zugang - ${companyName}`,
      greeting: "Hallo",
      intro: `Ihnen wurde Manager-Zugang zur Plattform ${companyName} gewährt. Verwenden Sie die folgenden Zugangsdaten, um sich anzumelden.`,
      credentialsTitle: "Ihre Zugangsdaten",
      labelEmail: "E-Mail:",
      labelTempPassword: "Temporäres Passwort:",
      labelEntity: "Entität:",
      buttonLabel: "Zum Dashboard",
      securityTitle: "Sicherheitshinweis",
      securityText:
        "Bitte ändern Sie Ihr temporäres Passwort unmittelbar nach der ersten Anmeldung. Dieses Passwort läuft in 7 Tagen ab.",
      helpText:
        "Wenn Sie Fragen haben oder Hilfe benötigen, wenden Sie sich bitte an unser Support-Team.",
      footerNeedHelp:
        "Brauchen Sie Hilfe? Kontaktieren Sie unser Support-Team:",
      websiteLabel: "Website",
      linkedinLabel: "LinkedIn",
      twitterLabel: "Twitter",
    };
  }

  return {
    subject: `Welcome to ${companyName} - Manager Access`,
    emailTitle: `Manager Access Invitation - ${companyName}`,
    greeting: "Hi",
    intro: `You've been granted Manager access to the ${companyName} platform. Use the credentials below to log in to your account.`,
    credentialsTitle: "Your Login Credentials",
    labelEmail: "Email:",
    labelTempPassword: "Temporary Password:",
    labelEntity: "Entity:",
    buttonLabel: "Access Your Dashboard",
    securityTitle: "Security Notice",
    securityText:
      "For your security, please change your temporary password immediately after your first login. This password will expire in 7 days.",
    helpText:
      "If you have any questions or need assistance, please don't hesitate to contact our support team.",
    footerNeedHelp: "Need help? Contact our support team:",
    websiteLabel: "Website",
    linkedinLabel: "LinkedIn",
    twitterLabel: "Twitter",
  };
};

const getPasswordResetCopy = (language: string, companyName: string) => {
  const lang = (language || "en").toLowerCase();

  if (lang === "pt" || lang.startsWith("pt-")) {
    return {
      subject: `Redefinir sua senha - ${companyName}`,
      greeting: "Olá",
      intro:
        "Recebemos uma solicitação para redefinir a senha da sua conta {{companyName}}. Se você não fez essa solicitação, ignore este email.",
      buttonLabel: "Redefinir senha",
      importantTitle: "Importante",
      importantText:
        "Este link para redefinir a senha expirará em {{expiryHours}} hora(s).",
      securityTitle: "Dicas de segurança",
      securityItem1: "Nunca compartilhe sua senha com ninguém",
      securityItem2:
        "Use uma senha forte com combinação de letras, números e símbolos",
      securityItem3:
        "Ative a autenticação em duas etapas para segurança adicional",
      linkHelp:
        "Se você tiver problemas para clicar no botão, copie e cole esta URL no seu navegador:",
      supportText:
        "Se você tiver qualquer dúvida ou precisar de ajuda, entre em contato com nossa equipe de suporte.",
      footerText: "Este email foi enviado por {{companyName}}",
      websiteLabel: "Site",
      linkedinLabel: "LinkedIn",
      twitterLabel: "Twitter",
    };
  }

  return {
    subject: `Reset Your Password - ${companyName}`,
    greeting: "Hi",
    intro:
      "We received a request to reset your password for your {{companyName}} account. If you didn't make this request, please ignore this email.",
    buttonLabel: "Reset Password",
    importantTitle: "Important",
    importantText:
      "This password reset link will expire in {{expiryHours}} hours.",
    securityTitle: "Security Tips",
    securityItem1: "Never share your password with anyone",
    securityItem2:
      "Use a strong password with a mix of letters, numbers, and symbols",
    securityItem3: "Enable two-factor authentication for additional security",
    linkHelp:
      "If you're having trouble clicking the button, copy and paste this URL into your browser:",
    supportText:
      "If you have any questions or need assistance, please contact our support team.",
    footerText: "This email was sent by {{companyName}}",
    websiteLabel: "Website",
    linkedinLabel: "LinkedIn",
    twitterLabel: "Twitter",
  };
};

const getEmailVerificationCopy = (language: string, companyName: string) => {
  const lang = (language || "en").toLowerCase();

  if (lang === "pt" || lang.startsWith("pt-")) {
    return {
      subject: `Verifique seu novo endereço de email - ${companyName}`,
      greeting: "Olá",
      intro:
        "Você solicitou a alteração do endereço de email da sua conta {{companyName}}. Para concluir essa alteração, confirme seu novo email clicando no botão abaixo.",
      buttonLabel: "Verificar email",
      importantTitle: "Importante",
      importantText:
        "Este link de verificação expirará em {{expiryHours}} hora(s).",
      securityTitle: "Dicas de segurança",
      securityItem1:
        "Se você não solicitou esta alteração de email, ignore esta mensagem",
      securityItem2:
        "Nunca compartilhe links de verificação com outras pessoas",
      securityItem3: "Mantenha sua conta segura usando uma senha forte e única",
      linkHelp:
        "Se você tiver problemas para clicar no botão, copie e cole esta URL no seu navegador:",
      supportText:
        "Se você tiver qualquer dúvida ou precisar de ajuda, entre em contato com nossa equipe de suporte.",
      footerText: "Este email foi enviado por {{companyName}}",
      websiteLabel: "Site",
      linkedinLabel: "LinkedIn",
      twitterLabel: "Twitter",
    };
  }

  return {
    subject: `Verify Your New Email Address - ${companyName}`,
    greeting: "Hi",
    intro:
      "You recently requested to change your email address for your {{companyName}} account. To complete this change, please verify your new email address by clicking the button below.",
    buttonLabel: "Verify Email Address",
    importantTitle: "Important",
    importantText:
      "This verification link will expire in {{expiryHours}} hours.",
    securityTitle: "Security Tips",
    securityItem1:
      "If you didn't request this email change, please ignore this email",
    securityItem2: "Never share verification links with anyone",
    securityItem3:
      "Keep your account secure by using a strong password and good security practices",
    linkHelp:
      "If you're having trouble clicking the button, copy and paste this URL into your browser:",
    supportText:
      "If you have any questions or need assistance, please contact our support team.",
    footerText: "This email was sent by {{companyName}}",
    websiteLabel: "Website",
    linkedinLabel: "LinkedIn",
    twitterLabel: "Twitter",
  };
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private configService: ConfigService) {
    const emailConfig = {
      host: this.configService.get<string>("email.smtp.host"),
      port: this.configService.get<number>("email.smtp.port"),
      secure: this.configService.get<boolean>("email.smtp.secure"), // true for port 465
      auth: {
        user: this.configService.get<string>("email.smtp.user"),
        pass: this.configService.get<string>("email.smtp.pass"),
      },
    };

    this.logger.log(
      `Initializing email service with host: ${emailConfig.host}:${emailConfig.port}`,
    );
    this.logger.debug(
      `Email service SMTP config - secure: ${emailConfig.secure ? "yes" : "no"}, user set: ${!!emailConfig.auth.user}`,
    );

    this.transporter = nodemailer.createTransport(emailConfig);
  }

  /**
   * Check if running on localhost
   * @returns true if running on localhost, false otherwise
   */
  private isLocalhost(): boolean {
    const nodeEnv =
      this.configService.get<string>("app.nodeEnv") ||
      process.env.NODE_ENV ||
      "development";
    const baseUrl =
      this.configService.get<string>("app.baseUrl") || "http://localhost:3000";
    const isTestEnv =
      nodeEnv === "test" ||
      typeof (process as any).env.JEST_WORKER_ID !== "undefined";
    return (
      !isTestEnv &&
      (nodeEnv === "development" ||
        baseUrl.includes("localhost") ||
        baseUrl.includes("127.0.0.1"))
    );
  }

  /**
   * Log email payload as JSON (for localhost development)
   */
  private logEmailPayload(
    emailType: string,
    email: string,
    templateData: Record<string, any>,
  ): void {
    this.logger.log(
      `[LOCALHOST] Email would be sent (${emailType}): to=${email}`,
    );
    this.logger.debug(
      `[LOCALHOST] Email payload (${emailType}): ${JSON.stringify(templateData, null, 2)}`,
    );
  }

  async sendInvitationEmail(
    email: string,
    templateId: string,
    templateData: Record<string, any>,
  ): Promise<void> {
    try {
      this.logger.debug(
        `Preparing invitation email: to=${email}, templateId=${templateId}`,
      );
      const template = await this.loadTemplate(templateId);

      // Ensure required template data is provided
      const languageCode =
        (templateData.language as string) ||
        this.configService.get<string>("email.defaultLanguage") ||
        "en";

      const companyName = getCompanyName();

      const userInvitationCopy =
        templateId === "user-invitation"
          ? getUserInvitationCopy(languageCode, companyName)
          : {};

      const managerInvitationCopy =
        templateId === "manager-invitation"
          ? getManagerInvitationCopy(languageCode, companyName)
          : {};

      const defaultTemplateData = {
        email,
        companyName,
        loginUrl: getFrontendUrl() + "/login",
        supportEmail: this.configService.get<string>("email.from.address"),
        language: languageCode,
        lang: (languageCode || "en").split("-")[0],
        ...userInvitationCopy,
        ...managerInvitationCopy,
        ...templateData,
      };

      // On localhost, just log the payload and skip sending
      if (this.isLocalhost()) {
        this.logEmailPayload("INVITATION", email, defaultTemplateData);
        return;
      }

      const html = template(defaultTemplateData);
      this.logger.debug(
        `Template compiled for invitation email: subject=${templateData.subject || `Welcome to ${defaultTemplateData.companyName}`}, htmlLength=${html?.length || 0}`,
      );

      const fromName =
        this.configService.get<string>("email.from.name") || "2N5";
      const fromAddress = this.configService.get<string>("email.from.address");

      const mailOptions = {
        from: `"${fromName}" <${fromAddress}>`,
        to: email,
        subject:
          templateData.subject ||
          (managerInvitationCopy as any).subject ||
          `Welcome to ${defaultTemplateData.companyName}`,
        html,
      };

      this.logger.debug(
        `Sending invitation email via transporter: to=${email}, from=${fromAddress}, subject="${mailOptions.subject}"`,
      );
      await this.transporter.sendMail(mailOptions);
      this.logger.log(`Invitation email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send invitation email to ${email}:`, error);
      throw error;
    }
  }

  async sendBulkEmails(
    emails: Array<{
      email: string;
      templateId: string;
      templateData: Record<string, any>;
    }>,
  ): Promise<{ success: number; failed: number; errors: any[] }> {
    let success = 0;
    let failed = 0;
    const errors: any[] = [];

    this.logger.debug(`Sending bulk emails: total=${emails.length}`);
    for (const emailData of emails) {
      try {
        this.logger.debug(
          `Bulk email item: to=${emailData.email}, templateId=${emailData.templateId}`,
        );
        await this.sendInvitationEmail(
          emailData.email,
          emailData.templateId,
          emailData.templateData,
        );
        success++;
      } catch (error) {
        failed++;
        errors.push({
          email: emailData.email,
          error: error.message,
        });
        this.logger.debug(
          `Bulk email failed: to=${emailData.email}, error=${error?.message}`,
        );
      }
    }

    return { success, failed, errors };
  }

  async sendPasswordResetEmail(
    email: string,
    data: {
      firstName: string;
      resetLink: string;
      expiryHours: number;
      logoUrl?: string;
      companyName?: string;
      companyAddress?: string;
      supportEmail?: string;
      socialLinks?: {
        website?: string;
        linkedin?: string;
        twitter?: string;
      };
    },
  ): Promise<void> {
    try {
      this.logger.debug(
        `Preparing password reset email: to=${email}, expiryHours=${data.expiryHours}`,
      );
      const template = await this.loadTemplate("reset-password");

      // Ensure required template data is provided with defaults
      const languageCode =
        (data as any).language ||
        this.configService.get<string>("email.defaultLanguage") ||
        "en";

      const companyNameForCopy =
        data.companyName ||
        this.configService.get<string>("email.company.name") ||
        "2N5";

      const copy = getPasswordResetCopy(languageCode, companyNameForCopy);

      const templateData = {
        firstName: data.firstName,
        resetLink: data.resetLink,
        expiryHours: data.expiryHours,
        // intentionally left out: no logo in verification/reset templates to avoid broken images in emails
        companyName:
          data.companyName ||
          this.configService.get<string>("email.company.name") ||
          "2N5",
        companyAddress:
          data.companyAddress ||
          this.configService.get<string>("email.company.address") ||
          "123 Business Street, Tech City",
        supportEmail:
          data.supportEmail ||
          this.configService.get<string>("email.support.address") ||
          "support@2n5global.com",
        socialLinks: {
          website:
            data.socialLinks?.website ||
            this.configService.get<string>("email.social.website") ||
            "https://2n5global.com",
          linkedin:
            data.socialLinks?.linkedin ||
            this.configService.get<string>("email.social.linkedin"),
          twitter:
            data.socialLinks?.twitter ||
            this.configService.get<string>("email.social.twitter"),
        },
        language: languageCode,
        ...copy,
      };

      // On localhost, just log the payload and skip sending
      if (this.isLocalhost()) {
        this.logEmailPayload("PASSWORD_RESET", email, templateData);
        return;
      }

      const html = template(templateData);
      this.logger.debug(
        `Template compiled for password reset: subject="Reset Your Password - ${templateData.companyName}", htmlLength=${html?.length || 0}`,
      );

      const fromName =
        this.configService.get<string>("email.from.name") ||
        templateData.companyName;
      const fromAddress = this.configService.get<string>("email.from.address");

      const mailOptions = {
        from: `"${fromName}" <${fromAddress}>`,
        to: email,
        subject: copy.subject,
        html,
      };

      this.logger.debug(
        `Sending password reset email: to=${email}, from=${fromAddress}`,
      );
      await this.transporter.sendMail(mailOptions);
      this.logger.log(`Password reset email sent to ${email}`);
    } catch (error) {
      this.logger.error(
        `Failed to send password reset email to ${email}:`,
        error,
      );
      throw error;
    }
  }

  private async loadTemplate(
    templateId: string,
  ): Promise<handlebars.TemplateDelegate> {
    try {
      const templatePath = path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "templates",
        `${templateId}.hbs`,
      );
      this.logger.debug(`Loading email template: path=${templatePath}`);
      const templateContent = fs.readFileSync(templatePath, "utf8");
      this.logger.debug(
        `Email template loaded: templateId=${templateId}, length=${templateContent.length}`,
      );
      return handlebars.compile(templateContent);
    } catch (error) {
      this.logger.error(`Failed to load template ${templateId}:`, error);
      // Return a default template if the specific template is not found
      return handlebars.compile(`
        <html>
          <body>
            <h1>Welcome to 2N5</h1>
            <p>Hello {{firstName}} {{lastName}},</p>
            <p>Welcome to 2N5 platform!</p>
            <p>Best regards,<br>The 2N5 Team</p>
          </body>
        </html>
      `);
    }
  }

  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      this.logger.log("Email service connection verified");
      return true;
    } catch (error) {
      this.logger.error("Email service connection failed:", error);
      return false;
    }
  }

  async sendInvitationEmailWithQR(
    email: string,
    data: {
      firstName: string;
      lastName: string;
      qrCode: string;
      sessionId: string;
      expiresAt: Date;
      language?: string;
    },
  ): Promise<void> {
    try {
      // Normalize expiresAt (may arrive as string when coming from queue deserialization)
      let normalizedExpiresAt: Date | null = null;
      if (data?.expiresAt instanceof Date) {
        normalizedExpiresAt = data.expiresAt;
      } else if (
        typeof (data as any)?.expiresAt === "string" ||
        typeof (data as any)?.expiresAt === "number"
      ) {
        const parsed = new Date((data as any).expiresAt);
        if (!isNaN(parsed.getTime())) {
          normalizedExpiresAt = parsed;
        }
      }
      const computedExpiryMinutes =
        normalizedExpiresAt && normalizedExpiresAt.getTime() > Date.now()
          ? Math.ceil(
              (normalizedExpiresAt.getTime() - Date.now()) / (1000 * 60),
            )
          : 60; // default fallback

      const fromName =
        this.configService.get<string>("email.from.name") || "2N5";
      const fromAddress = this.configService.get<string>("email.from.address");

      // Compute public QR link from sessionId (format: whatsapp-<digits>)
      const sessionDigits = (data.sessionId || "").replace(/^whatsapp-/, "");
      const phoneForLink = `+${sessionDigits}`;
      const publicQrLink = `${getFrontendUrl()}/public/whatsapp/qr/${encodeURIComponent(phoneForLink)}`;

      // Use the invitation template with QR code data
      const template = await this.loadTemplate("user-invitation");

      const languageCode =
        data.language ||
        this.configService.get<string>("email.defaultLanguage") ||
        "en";

      const companyName = getCompanyName();
      const copy = getUserInvitationCopy(languageCode, companyName);

      const templateData = {
        firstName: data.firstName,
        lastName: data.lastName,
        logoUrl: this.configService.get<string>("email.logo.url"),
        email: email,
        companyName,
        loginUrl: getFrontendUrl() + "/login",
        qrCodeImage: `data:image/png;base64,${data.qrCode}`,
        expiryMinutes: computedExpiryMinutes,
        qrCodeLink: publicQrLink,
        language: languageCode,
        ...copy,
      };

      // On localhost, just log the payload and skip sending
      if (this.isLocalhost()) {
        this.logEmailPayload("INVITATION_WITH_QR", email, templateData);
        return;
      }

      const qrLinkBlock = `
        <div style="margin-top: 16px; text-align: center;">
          <a href="${publicQrLink}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 10px 18px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">
            Open Live QR Code
          </a>
        </div>
        <p style="font-size: 12px; color: #6b7280; text-align: center; margin-top: 8px;">
          If the QR image above expires or does not load, click the button to view a fresh QR code in your browser.
        </p>
      `;

      let html = template(templateData);
      if (!html || html.trim() === "") {
        html = `
        <html>
          <body style="font-family: Arial, sans-serif;">
            <h2>Welcome to 2N5</h2>
            <p>Hello ${templateData.firstName} ${templateData.lastName},</p>
            <p>Please scan the QR below or click the link to open your live QR page:</p>
            <p><img alt="WhatsApp QR" src="${templateData.qrCodeImage}" style="width: 280px; height: 280px; object-fit: contain;" /></p>
            <div style="margin-top: 16px; text-align: center;">
              <a href="${publicQrLink}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 10px 18px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">
                Open Live QR Code
              </a>
            </div>
            <p style="font-size: 12px; color: #6b7280; text-align: center; margin-top: 8px;">
              This QR typically expires within ${templateData.expiryMinutes} minute(s). If it expires or fails to load, click the button above to fetch a fresh QR.
            </p>
          </body>
        </html>`;
      }

      const normalizedHtml = html.toLowerCase();
      if (!normalizedHtml.includes(publicQrLink.toLowerCase())) {
        const bodyCloseIndex = normalizedHtml.indexOf("</body>");
        if (bodyCloseIndex !== -1) {
          html =
            html.slice(0, bodyCloseIndex) +
            qrLinkBlock +
            html.slice(bodyCloseIndex);
        } else {
          html += qrLinkBlock;
        }
      }
      this.logger.debug(
        `Compiled invitation-with-QR email: to=${email}, sessionId=${data.sessionId}, expiresAt=${normalizedExpiresAt ? normalizedExpiresAt.toISOString() : "unknown"}, htmlLength=${html?.length || 0}`,
      );

      const mailOptions = {
        from: `"${fromName}" <${fromAddress}>`,
        to: email,
        subject: copy.subject,
        html: html,
      };

      this.logger.debug(
        `Sending invitation-with-QR email: to=${email}, from=${fromAddress}, sessionId=${data.sessionId}`,
      );
      await this.transporter.sendMail(mailOptions);
      this.logger.log(`Invitation email with QR code sent to ${email}`);
    } catch (error) {
      this.logger.error(
        `Failed to send invitation email with QR to ${email}:`,
        error,
      );
      throw error;
    }
  }

  async sendTestEmail(
    toEmail: string,
    subject: string = "2N5 - Test Email",
  ): Promise<void> {
    try {
      const fromName = this.configService.get<string>("email.from.name");
      const fromAddress = this.configService.get<string>("email.from.address");

      const html = `
        <html>
          <head>
            <style>
              body {
                font-family: Arial, sans-serif;
                line-height: 1.6;
                color: #333;
                max-width: 600px;
                margin: 0 auto;
                padding: 20px;
              }
              .header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 30px;
                border-radius: 10px 10px 0 0;
                text-align: center;
              }
              .content {
                background: #f9fafb;
                padding: 30px;
                border-radius: 0 0 10px 10px;
              }
              .badge {
                background: #10b981;
                color: white;
                padding: 5px 15px;
                border-radius: 20px;
                display: inline-block;
                margin: 10px 0;
              }
              .info-box {
                background: white;
                padding: 15px;
                border-left: 4px solid #667eea;
                margin: 15px 0;
              }
              .footer {
                text-align: center;
                color: #6b7280;
                font-size: 12px;
                margin-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>🚀 2N5 Email Service</h1>
              <p>Test Email Successfully Sent!</p>
            </div>
            <div class="content">
              <div class="badge">✅ Connected</div>
              
              <h2>Email Configuration Test</h2>
              <p>This is a test email from the 2N5 Integration Backend. If you're reading this, the email service is working correctly!</p>
              
              <div class="info-box">
                <strong>Configuration Details:</strong><br>
                <strong>SMTP Host:</strong> ${this.configService.get<string>("email.smtp.host")}<br>
                <strong>SMTP Port:</strong> ${this.configService.get<number>("email.smtp.port")}<br>
                <strong>Secure:</strong> ${this.configService.get<boolean>("email.smtp.secure") ? "Yes (SSL)" : "No"}<br>
                <strong>From:</strong> ${fromAddress}<br>
                <strong>Sent at:</strong> ${new Date().toLocaleString()}
              </div>
              
              <h3>Features Available:</h3>
              <ul>
                <li>✉️ Invitation Emails</li>
                <li>🔐 Password Reset Emails</li>
                <li>👋 Welcome Emails</li>
                <li>📧 Bulk Email Sending</li>
                <li>🎨 HTML Templates with Handlebars</li>
              </ul>
              
              <p><strong>Status:</strong> <span style="color: #10b981;">All systems operational</span></p>
              
              <div class="footer">
                <p>2N5 Integration Backend | Email Service Test</p>
                <p>This email was sent automatically. Please do not reply.</p>
              </div>
            </div>
          </body>
        </html>
      `;

      // On localhost, just log the payload and skip sending
      if (this.isLocalhost()) {
        this.logEmailPayload("TEST", toEmail, {
          subject: subject || "2N5 - Test Email",
          toEmail,
        });
        return;
      }

      const mailOptions = {
        from: `"${fromName}" <${fromAddress}>`,
        to: toEmail,
        subject: subject,
        html: html,
      };

      this.logger.debug(
        `Sending test email: to=${toEmail}, subject="${subject}", from=${fromAddress}`,
      );
      const info = await this.transporter.sendMail(mailOptions);
      this.logger.log(
        `Test email sent successfully to ${toEmail}. Message ID: ${info.messageId}`,
      );
    } catch (error) {
      this.logger.error(`Failed to send test email to ${toEmail}:`, error);
      throw error;
    }
  }

  async sendWhatsAppHealthAlert(
    toEmail: string,
    data: {
      sessionId: string;
      phoneNumber?: string;
      whatsappName?: string;
      lastHealthStatus?: string;
      consecutiveFailures?: number;
      reason?: string;
      language?: string;
    },
  ): Promise<void> {
    try {
      const fromName =
        this.configService.get<string>("email.from.name") || "2N5";
      const fromAddress = this.configService.get<string>("email.from.address");
      const companyName = getCompanyName();
      const supportEmail =
        this.configService.get<string>("support.email") ||
        this.configService.get<string>("email.from.address") ||
        "support@2n5global.com";
      const languageCode =
        data.language ||
        this.configService.get<string>("email.defaultLanguage") ||
        "en";
      const copy = getHealthAlertCopy(languageCode, companyName);

      const template = await this.loadTemplate("whatsapp-alert");
      const templateData = {
        ...copy,
        companyName,
        supportEmail,
        sessionId: data.sessionId,
        phoneNumber: data.phoneNumber,
        whatsappName: data.whatsappName,
        lastHealthStatus: data.lastHealthStatus || "failed",
        consecutiveFailures: data.consecutiveFailures,
        reason: data.reason,
        loginUrl: getFrontendUrl() + "/login",
      };

      const html = template(templateData);

      const mailOptions = {
        from: `"${fromName}" <${fromAddress}>`,
        to: toEmail,
        subject: copy.subject,
        html,
      };

      await this.transporter.sendMail(mailOptions);
      this.logger.log(
        `WhatsApp health alert sent to ${toEmail} for session ${data.sessionId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send WhatsApp health alert to ${toEmail}:`,
        error,
      );
    }
  }

  async sendEmailVerificationEmail(
    email: string,
    data: {
      firstName: string;
      lastName: string;
      verificationLink: string;
      expiryHours: number;
      logoUrl?: string;
      companyName?: string;
      companyAddress?: string;
      supportEmail?: string;
      socialLinks?: {
        website?: string;
        linkedin?: string;
        twitter?: string;
      };
    },
  ): Promise<void> {
    try {
      this.logger.debug(
        `Preparing email verification: to=${email}, expiryHours=${data.expiryHours}`,
      );
      const template = await this.loadTemplate("email-verification");

      // Ensure required template data is provided with defaults
      const languageCode =
        (data as any).language ||
        this.configService.get<string>("email.defaultLanguage") ||
        "en";

      const companyNameForCopy =
        data.companyName ||
        this.configService.get<string>("email.company.name") ||
        "2N5";

      const copy = getEmailVerificationCopy(languageCode, companyNameForCopy);

      const templateData = {
        firstName: data.firstName,
        lastName: data.lastName,
        verificationLink: data.verificationLink,
        expiryHours: data.expiryHours,
        // intentionally left out: no logo in verification/reset templates to avoid broken images in emails
        companyName:
          data.companyName ||
          this.configService.get<string>("email.company.name") ||
          "2N5",
        companyAddress:
          data.companyAddress ||
          this.configService.get<string>("email.company.address") ||
          "123 Business Street, Tech City",
        supportEmail:
          data.supportEmail ||
          this.configService.get<string>("email.support.address") ||
          "support@2n5global.com",
        socialLinks: {
          website:
            data.socialLinks?.website ||
            this.configService.get<string>("email.social.website") ||
            "https://2n5global.com",
          linkedin:
            data.socialLinks?.linkedin ||
            this.configService.get<string>("email.social.linkedin"),
          twitter:
            data.socialLinks?.twitter ||
            this.configService.get<string>("email.social.twitter"),
        },
        language: languageCode,
        ...copy,
      };

      // On localhost, just log the payload and skip sending
      if (this.isLocalhost()) {
        this.logEmailPayload("EMAIL_VERIFICATION", email, templateData);
        return;
      }

      const html = template(templateData);
      this.logger.debug(
        `Compiled email verification template: to=${email}, htmlLength=${html?.length || 0}`,
      );

      const fromName =
        this.configService.get<string>("email.from.name") ||
        templateData.companyName;
      const fromAddress = this.configService.get<string>("email.from.address");

      const mailOptions = {
        from: `"${fromName}" <${fromAddress}>`,
        to: email,
        subject: copy.subject,
        html,
      };

      this.logger.debug(
        `Sending email verification: to=${email}, from=${fromAddress}`,
      );
      await this.transporter.sendMail(mailOptions);
      this.logger.log(`Email verification email sent to ${email}`);
    } catch (error) {
      this.logger.error(
        `Failed to send email verification email to ${email}:`,
        error,
      );
      throw error;
    }
  }
}

// Server-generated texts shown to customers, in their language (falls back to English).

type Lang = 'en' | 'de' | 'fa' | 'es' | 'fr';

const pick = (language: string | null | undefined): Lang => {
  const code = language?.slice(0, 2).toLowerCase();
  return code === 'de' || code === 'fa' || code === 'es' || code === 'fr' ? code : 'en';
};

const TEXT: Record<
  Lang,
  {
    handoffOnline: string;
    handoffOffline: (when: string | null) => string;
    /** Offline, but we already know how to reach the customer (e.g. WhatsApp, email on file). */
    handoffOfflineKnownContact: (when: string | null) => string;
    fallbackOnline: string;
    fallbackOffline: string;
    talkToHuman: string;
    cannotShareInternals: string;
  }
> = {
  en: {
    handoffOnline: "I've asked a member of our team to join. Someone will be with you shortly — feel free to add any details in the meantime.",
    handoffOffline: (when) =>
      `Our team is offline right now${when ? ` and back ${when}` : ''}. Leave your email or phone number here and we'll follow up — I'm happy to keep helping in the meantime.`,
    handoffOfflineKnownContact: (when) =>
      `Our team is offline right now${when ? ` and back ${when}` : ''}. I've passed your request on and someone will get back to you — I'm happy to keep helping in the meantime.`,
    fallbackOnline: "I'm sorry — I'm having trouble answering right now. You can ask for a member of our team, or try again in a moment.",
    fallbackOffline: "I'm sorry — I'm having trouble answering right now. Please try again in a moment, or leave your email and our team will follow up.",
    talkToHuman: 'Talk to a human',
    cannotShareInternals: "I can't share details about how I'm configured, but I'm happy to help with your question. What can I do for you?",
  },
  de: {
    handoffOnline: 'Ich habe ein Teammitglied gebeten, dazuzukommen. Gleich ist jemand für Sie da – ergänzen Sie gern schon Details.',
    handoffOffline: (when) =>
      `Unser Team ist gerade nicht erreichbar${when ? ` und wieder ${when} da` : ''}. Hinterlassen Sie hier Ihre E-Mail-Adresse oder Telefonnummer, wir melden uns – bis dahin helfe ich gern weiter.`,
    handoffOfflineKnownContact: (when) =>
      `Unser Team ist gerade nicht erreichbar${when ? ` und wieder ${when} da` : ''}. Ich habe Ihr Anliegen weitergegeben, wir melden uns bei Ihnen – bis dahin helfe ich gern weiter.`,
    fallbackOnline: 'Entschuldigung – ich kann gerade nicht antworten. Sie können ein Teammitglied anfragen oder es gleich noch einmal versuchen.',
    fallbackOffline: 'Entschuldigung – ich kann gerade nicht antworten. Bitte versuchen Sie es gleich noch einmal oder hinterlassen Sie Ihre E-Mail-Adresse, damit unser Team sich meldet.',
    talkToHuman: 'Mit einem Menschen sprechen',
    cannotShareInternals: 'Details zu meiner Konfiguration kann ich nicht teilen – aber bei Ihrem Anliegen helfe ich gern. Was kann ich für Sie tun?',
  },
  fa: {
    handoffOnline: 'از یکی از اعضای تیم خواستم به گفتگو بپیوندد. به‌زودی کسی در خدمت شماست — در این فاصله می‌توانید جزئیات را بنویسید.',
    handoffOffline: (when) =>
      `تیم ما در حال حاضر در دسترس نیست${when ? ` و ${when} بازمی‌گردد` : ''}. ایمیل یا شماره تلفن خود را اینجا بگذارید تا با شما تماس بگیریم — تا آن زمان با کمال میل کمکتان می‌کنم.`,
    handoffOfflineKnownContact: (when) =>
      `تیم ما در حال حاضر در دسترس نیست${when ? ` و ${when} بازمی‌گردد` : ''}. درخواست شما را ارسال کردم و با شما تماس خواهیم گرفت — تا آن زمان با کمال میل کمکتان می‌کنم.`,
    fallbackOnline: 'متأسفم — در حال حاضر نمی‌توانم پاسخ دهم. می‌توانید درخواست گفتگو با یکی از اعضای تیم را بدهید یا کمی بعد دوباره امتحان کنید.',
    fallbackOffline: 'متأسفم — در حال حاضر نمی‌توانم پاسخ دهم. لطفاً کمی بعد دوباره امتحان کنید یا ایمیل خود را بگذارید تا تیم ما پیگیری کند.',
    talkToHuman: 'گفتگو با کارشناس',
    cannotShareInternals: 'نمی‌توانم جزئیات تنظیمات خودم را به اشتراک بگذارم، اما با کمال میل در مورد سؤال شما کمک می‌کنم. چه کاری می‌توانم برایتان انجام دهم؟',
  },
  es: {
    handoffOnline: 'He pedido a una persona del equipo que se una. Enseguida te atenderán; mientras tanto puedes añadir detalles.',
    handoffOffline: (when) =>
      `Nuestro equipo no está disponible ahora${when ? ` y vuelve ${when}` : ''}. Deja aquí tu correo o teléfono y te contactaremos; mientras tanto, sigo ayudándote encantado.`,
    handoffOfflineKnownContact: (when) =>
      `Nuestro equipo no está disponible ahora${when ? ` y vuelve ${when}` : ''}. He pasado tu solicitud y te contactaremos; mientras tanto, sigo ayudándote encantado.`,
    fallbackOnline: 'Lo siento, ahora mismo no puedo responder. Puedes pedir hablar con una persona del equipo o intentarlo de nuevo en un momento.',
    fallbackOffline: 'Lo siento, ahora mismo no puedo responder. Inténtalo de nuevo en un momento o deja tu correo y el equipo te contactará.',
    talkToHuman: 'Hablar con una persona',
    cannotShareInternals: 'No puedo compartir detalles sobre mi configuración, pero con gusto te ayudo con tu consulta. ¿En qué puedo ayudarte?',
  },
  fr: {
    handoffOnline: "J'ai demandé à un membre de l'équipe de nous rejoindre. Quelqu'un sera là sous peu — n'hésitez pas à ajouter des détails.",
    handoffOffline: (when) =>
      `Notre équipe n'est pas disponible pour le moment${when ? ` et revient ${when}` : ''}. Laissez votre e-mail ou votre numéro ici et nous vous recontacterons — je reste à votre disposition en attendant.`,
    handoffOfflineKnownContact: (when) =>
      `Notre équipe n'est pas disponible pour le moment${when ? ` et revient ${when}` : ''}. J'ai transmis votre demande et nous vous recontacterons — je reste à votre disposition en attendant.`,
    fallbackOnline: "Désolé, je n'arrive pas à répondre pour le moment. Vous pouvez demander un membre de l'équipe ou réessayer dans un instant.",
    fallbackOffline: "Désolé, je n'arrive pas à répondre pour le moment. Réessayez dans un instant ou laissez votre e-mail pour que l'équipe vous recontacte.",
    talkToHuman: 'Parler à une personne',
    cannotShareInternals: 'Je ne peux pas partager les détails de ma configuration, mais je vous aide volontiers. Que puis-je faire pour vous ?',
  },
};

export function systemText(language: string | null | undefined) {
  return TEXT[pick(language)];
}

/** "Monday 09:00" in the customer's language, in the organization's time zone. */
export function formatOpening(date: Date, timeZone: string, language: string | null | undefined): string {
  return new Intl.DateTimeFormat(pick(language), { timeZone, weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(date);
}

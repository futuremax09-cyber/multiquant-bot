import { DurableObject } from "cloudflare:workers";

/**
 * MULTIQUANT ACADEMY — ALL-IN-ONE CLOUDFLARE WORKER
 * --------------------------------------------------
 * Telegram + Cloudflare D1 + Gemini + OKX USDT Perpetuals + RSS News
 *
 * CORE FLOW
 * 1. User joins @multiquantacademy
 * 2. Bot posts welcome + 5 interest buttons in the channel
 * 3. Button opens private bot using Telegram deep-link payload
 * 4. Private bot remembers selected interest and runs a sales conversation
 * 5. Qualification: interest -> trading type -> capital -> experience -> goal
 * 6. Qualified lead -> user gets correct team button + team gets private lead alert
 * 7. Follow-ups run on Cloudflare Cron
 * 8. News posts can use configured RSS feeds
 * 9. Economic alerts use an external calendar API because actual/forecast/previous
 *    must come from a data provider, never from Gemini
 * 10. Crypto signals scan all live OKX USDT-margined perpetuals using public market data
 *
 * REQUIRED CLOUDFLARE:
 *   Secrets:
 *     TELEGRAM_BOT_TOKEN
 *     GEMINI_API_KEY
 *
 *   D1 binding:
 *     DB -> multiquant-db
 *
 * RECOMMENDED VARIABLES:
 *   GEMINI_MODEL=gemini-3.1-flash-lite
 *   BOT_USERNAME=multiquantacademybot
 *   CHANNEL_USERNAME=@multiquantacademy
 *   CHANNEL_CHAT_ID=@multiquantacademy
 *   TEAM_ALERT_CHAT_ID=<private team group/channel chat id>
 *   ADMIN_CHAT_ID=<admin Telegram ID>
 *   CRON_SECRET=<random secret for /cron endpoint>
 *
 * OPTIONAL:
 *   CRYPTO_TEAM=@MRSUKVEL
 *   FOREX_TEAM=@Multiquantteam
 *   STOCK_TEAM=@Multiquantteam
 *   NEWS_FEEDS_JSON=<optional override; built-in feeds are enabled by default>
 *   ECONOMIC_API_URL=<optional override; built-in free calendar sources are enabled by default>
 *   ECONOMIC_API_KEY=<optional calendar provider key>
 *   SIGNALS_ENABLED=true
 *   NEWS_ENABLED=true
 *   ECONOMIC_ENABLED=true
 *   FOLLOWUPS_ENABLED=true
 *
 * IMPORTANT TELEGRAM SETUP:
 * The bot must be admin in the channel to receive chat_member updates.
 * The webhook must include allowed_updates:
 *   ["message","callback_query","chat_member"]
 * See /setup-webhook below.
 */

const DEFAULTS = {
  BOT_USERNAME: "multiquantacademybot",
  CHANNEL_USERNAME: "@multiquantacademy",
  CHANNEL_CHAT_ID: "@multiquantacademy",
  CRYPTO_TEAM: "@MRSUKVEL",
  FOREX_TEAM: "@Multiquantteam",
  STOCK_TEAM: "@Multiquantteam",
  GEMINI_MODEL: "gemini-3.1-flash-lite",

  // The worker can run without these optional modules.
  NEWS_ENABLED: true,
  ECONOMIC_ENABLED: true,
  SIGNALS_ENABLED: true,
  FOLLOWUPS_ENABLED: true,

  // Publish 5–7 strongest setups per signal run; ranking is intentionally moderate.
  SIGNAL_TARGET_MIN: 1,
  SIGNAL_TARGET_MAX: 1,
  SIGNAL_MAX_24H: 30,
  SIGNAL_MIN_GAP_MINUTES: 45,
  SIGNAL_SCAN_INTERVAL_MINUTES: 15,

  // Follow-up schedule: days after last meaningful interaction.
  FOLLOWUP_DAYS: [1, 2, 3, 5, 7],

  MAX_HISTORY: 24
};

const INTERESTS = {
  forex: {
    key: "forex",
    label: "Forex Trading",
    market: "Forex",
    tradingType: "",
    team: "forex"
  },
  forex_copy: {
    key: "forex_copy",
    label: "Forex Copy Trading",
    market: "Forex",
    tradingType: "Copy Trading",
    team: "forex"
  },
  stocks: {
    key: "stocks",
    label: "Indian Stock Market",
    market: "Indian Stocks",
    tradingType: "Self Trading",
    team: "stocks"
  },
  crypto_signals: {
    key: "crypto_signals",
    label: "Crypto Premium Signals",
    market: "Crypto",
    tradingType: "Self Trading",
    team: "crypto"
  },
  crypto_copy: {
    key: "crypto_copy",
    label: "Crypto Copy Trading",
    market: "Crypto",
    tradingType: "Copy Trading",
    team: "crypto"
  }
};

// D1 schema is stable after deployment. Cache the initialization per Worker isolate
// so every Telegram message does NOT execute 9+ CREATE/INDEX statements again.
let schemaReady = false;
let schemaPromise = null;

/* ============================================================
   CLOUDFLARE ENTRY
============================================================ */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return textResponse("MultiQuant Academy Bot is running.");
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          model: getEnv(env, "GEMINI_MODEL", DEFAULTS.GEMINI_MODEL),
          db: !!env.DB,
          telegram: !!env.TELEGRAM_BOT_TOKEN,
          gemini: !!env.GEMINI_API_KEY,
          time: new Date().toISOString()
        });
      }

      if (request.method === "GET" && url.pathname === "/setup-webhook") {
        const secret = url.searchParams.get("secret") || "";
        if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
          return textResponse("Forbidden", 403);
        }
        const result = await setWebhook(env);
        return jsonResponse(result);
      }

      if (request.method === "POST" && url.pathname === "/webhook") {
        const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET || "";
        if (webhookSecret) {
          const incoming = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
          if (incoming !== webhookSecret) {
            return textResponse("Forbidden", 403);
          }
        }

        const update = await request.json();
        // Acknowledge Telegram immediately; continue processing in the background.
        ctx.waitUntil(handleUpdate(update, env));
        return textResponse("OK");
      }

      if (request.method === "POST" && url.pathname === "/cron") {
        const incoming = request.headers.get("X-Cron-Secret") || "";
        if (!env.CRON_SECRET || incoming !== env.CRON_SECRET) {
          return textResponse("Forbidden", 403);
        }
        await runScheduledJobs(env);
        return textResponse("CRON OK");
      }

      return textResponse("Not Found", 404);
    } catch (error) {
      console.error("FETCH ERROR", error);
      return textResponse("Internal Server Error", 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledJobs(env));
  }
};

/* ============================================================
   UPDATE ROUTER
============================================================ */

async function handleUpdate(update, env) {
  if (!update) return;

  if (update.message) {
    await handleMessage(update.message, env);
    return;
  }

  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  if (update.chat_member) {
    await handleChatMember(update.chat_member, env);
  }
}

/* ============================================================
   PRIVATE CHAT MESSAGE
============================================================ */

async function handleMessage(message, env) {
  if (!message || !message.chat || message.chat.type !== "private") return;

  const user = message.from || {};
  const userId = String(user.id || "");
  const chatId = String(message.chat.id || "");
  const text = String(message.text || "").trim();

  if (!userId || !chatId || !text) return;

  await ensureUser(env, userId, user.first_name || "Friend", user.username || "");

  // /start can contain a deep-link payload.
  if (text === "/start" || text.indexOf("/start ") === 0) {
    const payload = text.length > 6 ? text.slice(7).trim() : "";
    await handleStart(userId, chatId, user, payload, env);
    return;
  }

  const current = await getUser(env, userId);

  if (isStopMessage(text)) {
    await saveMessage(env, userId, "user", text);
    await updateUser(env, userId, {
      lead_status: "not_interested",
      followup_status: "stopped",
      last_interaction: now()
    });

    await sendTelegram(
      env,
      chatId,
      "Understood. 🔕 I’ll stop the promotional follow-ups. You can message me anytime if you want to continue."
    );
    return;
  }

  if (isAdminCommand(text) && isAdmin(userId, env)) {
    await handleAdminCommand(chatId, text, env);
    return;
  }

  const language = detectLanguage(text);
  const facts = extractLeadFacts(text, current);
  const languageUpdate = shouldUpdateLanguage(text) ? language : (current.language || "English");

  await updateUser(env, userId, Object.assign({}, facts, {
    language: languageUpdate,
    last_followup_day: 0,
    last_interaction: now()
  }));

  await saveMessage(env, userId, "user", text);

  const userAfterUpdate = await getUser(env, userId);

  // Qualified leads never restart qualification. They get a direct answer only.
  if (userAfterUpdate.lead_status === "qualified" || userAfterUpdate.lead_status === "team_referred") {
    const answer = await generateSalesAI(
      env,
      buildPostQualificationPrompt(userAfterUpdate, text)
    );

    await saveMessage(env, userId, "assistant", answer);
    await sendTelegram(env, chatId, answer, existingTeamKeyboard(userAfterUpdate));
    return;
  }

  // Keep the sales flow short and deterministic. Buttons collect the 2–3 facts
  // the team actually needs; Gemini is used only when the user asks a real question.
  if (qualificationComplete(userAfterUpdate)) {
    await qualifyAndHandoff(env, userId, chatId);
    return;
  }

  const directQuestion = /[?؟]/.test(text) || containsAny(text.toLowerCase(), [
    "what is", "how does", "how it works", "price", "pricing", "charges",
    "free", "kya hai", "kaise hota", "kaise kaam", "kitna", "fees"
  ]);

  if (directQuestion) {
    const answer = await generateSalesAI(
      env,
      buildShortSalesAnswerPrompt(userAfterUpdate, text)
    );
    const latestUser = await getUser(env, userId);
    await saveMessage(env, userId, "assistant", answer);
    await sendTelegram(env, chatId, answer + "\n\n" + nextQualificationText(latestUser), qualificationKeyboard(latestUser));
    return;
  }

  const latestUser = await getUser(env, userId);
  await sendQualificationStep(env, chatId, userId, latestUser);
}

/* ============================================================
   START + DEEP LINK
============================================================ */

async function handleStart(userId, chatId, telegramUser, payload, env) {
  await saveMessage(env, userId, "user", "/start " + payload);

  // Default English every fresh start.
  await updateUser(env, userId, {
    language: "English",
    lead_status: "new",
    followup_status: "active",
    last_followup_day: 0,
    last_interaction: now()
  });

  const selected = interestFromPayload(payload);

  if (selected) {
    await updateUser(env, userId, {
      interest: selected.label,
      market: selected.market,
      trading_type: selected.tradingType || "",
      requirement: selected.label,
      lead_status: "interested",
      followup_status: "active",
      last_followup_day: 0,
      last_interaction: now()
    });

    const latest = await getUser(env, userId);
    const intro =
      "Great choice 👍 *" + escapeMarkdown(selected.label) + "* is noted.\n\n" +
      nextQualificationText(latest);

    await saveMessage(env, userId, "assistant", intro);
    await sendTelegram(env, chatId, intro, qualificationKeyboard(latest));
    return;
  }

  await sendPrivateWelcome(env, chatId, telegramUser.first_name || "Friend");
}

function interestFromPayload(payload) {
  const clean = String(payload || "").toLowerCase();

  if (clean === "i_forex") return INTERESTS.forex;
  if (clean === "i_forex_copy") return INTERESTS.forex_copy;
  if (clean === "i_stocks") return INTERESTS.stocks;
  if (clean === "i_crypto_signals") return INTERESTS.crypto_signals;
  if (clean === "i_crypto_copy") return INTERESTS.crypto_copy;

  return null;
}

async function sendPrivateWelcome(env, chatId, firstName) {
  const text =
    "🔥 *WELCOME TO MULTIQUANT ACADEMY* 🔥\n\n" +
    "Hey " + escapeMarkdown(firstName) + " 👋\n\n" +
    "Tell me what you’re interested in and I’ll guide you personally.\n\n" +
    "📊 Forex • Copy Trading • Stocks • Crypto";

  await sendTelegram(env, chatId, text, privateInterestKeyboard(env));
}

function privateInterestKeyboard(env) {
  return {
    inline_keyboard: [
      [{ text: "💱 Forex Trading", callback_data: "interest_forex" }],
      [{ text: "📈 Copy Trading in Forex", callback_data: "interest_forex_copy" }],
      [{ text: "🇮🇳 Indian Stock Market", callback_data: "interest_stocks" }],
      [{ text: "₿ Crypto Premium Signals", callback_data: "interest_crypto_signals" }],
      [{ text: "🚀 Crypto Copy Trading", callback_data: "interest_crypto_copy" }]
    ]
  };
}

/* ============================================================
   CHANNEL MEMBER WELCOME
============================================================ */

async function handleChatMember(update, env) {
  const chat = update.chat;
  const newMember = update.new_chat_member;
  const oldMember = update.old_chat_member;

  if (!chat || !newMember || !newMember.user) return;

  // This handler is ONLY for the configured broadcast channel.
  // Never send the channel welcome to private chats, groups, or lead groups.
  if (chat.type !== "channel") return;

  const activeStatuses = ["member", "administrator", "creator"];
  const oldStatus = oldMember ? oldMember.status : "";
  const joined =
    activeStatuses.indexOf(newMember.status) >= 0 &&
    activeStatuses.indexOf(oldStatus) < 0;

  if (!joined) return;

  const configuredChannel = getEnv(
    env,
    "CHANNEL_CHAT_ID",
    DEFAULTS.CHANNEL_CHAT_ID
  );

  // Strictly match the configured channel. If a numeric chat ID is configured,
  // compare IDs. If @username is configured, compare Telegram's channel username.
  const configured = String(configuredChannel || "").trim();
  const configuredUsername = configured.startsWith("@")
    ? configured.slice(1).toLowerCase()
    : configured.toLowerCase();
  const chatUsername = String(chat.username || "").toLowerCase();

  const channelMatches = configured.startsWith("@")
    ? chatUsername === configuredUsername
    : String(chat.id) === configured;

  if (!channelMatches) return;

  const member = newMember.user;
  const userId = String(member.id);

  await ensureUser(
    env,
    userId,
    member.first_name || "Friend",
    member.username || ""
  );

  await updateUser(env, userId, {
    joined_community: 1,
    last_interaction: now()
  });

  // The channel welcome uses URL deep-links. Telegram opens the private bot
  // and passes the selected interest in /start payload.
  const botUsername = getEnv(
    env,
    "BOT_USERNAME",
    DEFAULTS.BOT_USERNAME
  );

  const welcome =
    "🔥 *WELCOME TO MULTIQUANT ACADEMY* 🔥\n\n" +
    "Hey " + escapeMarkdown(member.first_name || "Friend") + " 👋\n\n" +
    "Welcome to the world of *Smart Trading!* 🚀\n\n" +
    "What you see here is just the *TRAILER…* 🎬\n\n" +
    "The *REAL EXPERIENCE* is waiting inside our FREE Premium Channels. 💎\n\n" +
    "📊 Forex • Copy Trading • Stocks • Crypto\n" +
    "🚨 Signals • Market News • Economic Alerts\n\n" +
    "👇 *WHAT ARE YOU INTERESTED IN?*";

  const keyboard = channelInterestKeyboard(botUsername);

  await sendTelegram(env, String(chat.id), welcome, keyboard);

  // Optional internal team/admin notice. This is NOT a public member profile.
  const alertChat = env.ADMIN_CHAT_ID || env.TEAM_ALERT_CHAT_ID || "";
  if (alertChat) {
    await sendTelegram(
      env,
      alertChat,
      "👋 *NEW CHANNEL MEMBER*\n\n" +
      "Name: " + escapeMarkdown(member.first_name || "Friend") + "\n" +
      "Username: " +
      (member.username ? "@" + escapeMarkdown(member.username) : "Not available") +
      "\nTelegram ID: " + userId +
      "\n\nNo trading preference has been collected yet."
    );
  }
}

function channelInterestKeyboard(botUsername) {
  const base = "https://t.me/" + stripAt(botUsername);

  return {
    inline_keyboard: [
      [{ text: "💱 Forex Trading", url: base + "?start=i_forex" }],
      [{ text: "📈 Copy Trading in Forex", url: base + "?start=i_forex_copy" }],
      [{ text: "🇮🇳 Indian Stock Market", url: base + "?start=i_stocks" }],
      [{ text: "₿ Crypto Premium Signals", url: base + "?start=i_crypto_signals" }],
      [{ text: "🚀 Crypto Copy Trading", url: base + "?start=i_crypto_copy" }]
    ]
  };
}

/* ============================================================
   CALLBACKS
============================================================ */

async function handleCallback(callback, env) {
  if (!callback) return;

  const userId = String(callback.from && callback.from.id || "");
  const chatId = String(
    callback.message && callback.message.chat
      ? callback.message.chat.id
      : ""
  );
  const data = String(callback.data || "");

  await answerCallback(env, callback.id);

  if (data.indexOf("interest_") === 0) {
    const key = data.slice("interest_".length);
    const selected = INTERESTS[key];

    if (!selected) return;

    await ensureUser(
      env,
      userId,
      callback.from.first_name || "Friend",
      callback.from.username || ""
    );

    await updateUser(env, userId, {
      language: "English",
      interest: selected.label,
      market: selected.market,
      trading_type: selected.tradingType || "",
      requirement: selected.label,
      lead_status: "interested",
      followup_status: "active",
      last_followup_day: 0,
      last_interaction: now()
    });

    const latest = await getUser(env, userId);
    const message =
      "Great choice 👍 *" + escapeMarkdown(selected.label) + "* is noted.\n\n" +
      nextQualificationText(latest);

    await saveMessage(env, userId, "user", "[Selected button: " + selected.label + "]");
    await saveMessage(env, userId, "assistant", message);

    await sendTelegram(env, chatId, message, qualificationKeyboard(latest));
    return;
  }

  if (data.indexOf("mode_") === 0) {
    const modeMap = {
      mode_self: "Self Trading",
      mode_signals: "Signals",
      mode_copy: "Copy Trading"
    };
    const mode = modeMap[data];
    if (!mode) return;
    await updateUser(env, userId, {
      trading_type: mode,
      last_followup_day: 0,
      last_interaction: now()
    });
    const latest = await getUser(env, userId);
    await saveMessage(env, userId, "user", "[Selected: " + mode + "]");
    if (qualificationComplete(latest)) {
      await qualifyAndHandoff(env, userId, chatId);
    } else {
      await sendQualificationStep(env, chatId, userId, latest);
    }
    return;
  }

  if (data.indexOf("capital_") === 0) {
    const capitalMap = {
      capital_under500: "Under $500",
      capital_500_2k: "$500–$2,000",
      capital_2k_5k: "$2,000–$5,000",
      capital_5k_plus: "$5,000+",
      capital_private: "Prefer not to say"
    };
    const capital = capitalMap[data];
    if (!capital) return;
    await updateUser(env, userId, {
      capital: capital,
      last_followup_day: 0,
      last_interaction: now()
    });
    const latest = await getUser(env, userId);
    await saveMessage(env, userId, "user", "[Selected capital: " + capital + "]");
    if (qualificationComplete(latest)) {
      await qualifyAndHandoff(env, userId, chatId);
    } else {
      await sendQualificationStep(env, chatId, userId, latest);
    }
    return;
  }

  if (data.indexOf("experience_") === 0) {
    const experienceMap = {
      experience_beginner: "Beginner",
      experience_some: "Some Experience",
      experience_experienced: "Experienced"
    };
    const experience = experienceMap[data];
    if (!experience) return;
    await updateUser(env, userId, {
      experience: experience,
      last_followup_day: 0,
      last_interaction: now()
    });
    const latest = await getUser(env, userId);
    await saveMessage(env, userId, "user", "[Selected experience: " + experience + "]");
    if (qualificationComplete(latest)) {
      await qualifyAndHandoff(env, userId, chatId);
    } else {
      await sendQualificationStep(env, chatId, userId, latest);
    }
    return;
  }

  if (data === "connect_team") {
    await qualifyAndHandoff(env, userId, chatId);
    return;
  }

  if (data === "more_questions") {
    const user = await getUser(env, userId);
    const response = await generateSalesAI(
      env,
      buildPostQualificationPrompt(
        user,
        "I have more questions. Please help me."
      )
    );

    await saveMessage(env, userId, "assistant", response);
    await sendTelegram(env, chatId, response, existingTeamKeyboard(user));
    return;
  }

  if (data === "not_interested") {
    await updateUser(env, userId, {
      lead_status: "not_interested",
      followup_status: "stopped",
      last_interaction: now()
    });

    await sendTelegram(
      env,
      chatId,
      "No problem 👍 I’ll stop the promotional follow-ups. If you want to explore it later, just message me."
    );
  }
}

function firstQuestionForInterest(selected) {
  return nextQualificationText({
    interest: selected.label,
    trading_type: selected.tradingType || "",
    capital: "",
    experience: ""
  });
}

function getQualificationStep(user) {
  if (!user.interest) return "interest";
  if (!user.trading_type) return "trading_type";
  if (!user.capital) return "capital";
  if (!user.experience) return "experience";
  return "handoff";
}

function qualificationComplete(user) {
  return !!(
    user.interest &&
    user.trading_type &&
    user.capital &&
    user.experience
  );
}

function nextQualificationText(user) {
  const step = getQualificationStep(user);
  if (step === "trading_type") {
    return "How would you like to proceed? Choose one option below 👇";
  }
  if (step === "capital") {
    return "What is your approximate starting capital? Choose a range 👇";
  }
  if (step === "experience") {
    return "And your trading experience? 👇";
  }
  if (step === "handoff") {
    return "Thanks — I have the key details. I’ll connect you with the right team. 👇";
  }
  return "Choose what you’re interested in 👇";
}

function qualificationKeyboard(user) {
  const step = getQualificationStep(user);

  if (step === "trading_type") {
    return { inline_keyboard: [
      [{ text: "👤 Self Trading", callback_data: "mode_self" }],
      [{ text: "📊 Signals", callback_data: "mode_signals" }],
      [{ text: "🤝 Copy Trading", callback_data: "mode_copy" }]
    ] };
  }

  if (step === "capital") {
    return { inline_keyboard: [
      [{ text: "< $500", callback_data: "capital_under500" }, { text: "$500–$2K", callback_data: "capital_500_2k" }],
      [{ text: "$2K–$5K", callback_data: "capital_2k_5k" }, { text: "$5K+", callback_data: "capital_5k_plus" }],
      [{ text: "Prefer not to say", callback_data: "capital_private" }]
    ] };
  }

  if (step === "experience") {
    return { inline_keyboard: [
      [{ text: "🌱 Beginner", callback_data: "experience_beginner" }],
      [{ text: "📈 Some Experience", callback_data: "experience_some" }],
      [{ text: "💼 Experienced", callback_data: "experience_experienced" }]
    ] };
  }

  return null;
}

async function sendQualificationStep(env, chatId, userId, user) {
  if (qualificationComplete(user)) {
    await qualifyAndHandoff(env, userId, chatId);
    return;
  }

  const text = nextQualificationText(user);
  await saveMessage(env, userId, "assistant", text);
  await sendTelegram(env, chatId, text, qualificationKeyboard(user));
}

/* ============================================================
   SALES PROMPTS
============================================================ */

function buildShortSalesAnswerPrompt(user, latest) {
  return `
You are the concise sales assistant for MultiQuant Academy.
Answer the user's CURRENT question first, in the same language/style as the user.
Do not restart qualification. Do not ask a new question in your answer.
Do not invent prices, deposits, ROI, profits, performance, testimonials or availability.
If the exact commercial fact is unknown, say the team can confirm it.
Keep the answer to 2–4 short sentences.

USER PROFILE:
Interest: ${user.interest || "Unknown"}
Market: ${user.market || "Unknown"}
Trading type: ${user.trading_type || "Unknown"}
Capital: ${user.capital || "Unknown"}
Experience: ${user.experience || "Unknown"}

USER QUESTION:
${latest}
`;
}

function buildQualificationPrompt(user, latest, step) {
  return `
You are the personal sales consultant for MultiQuant Academy.
Use the user's latest language/style. Be concise and human.
The qualification flow is button-driven and intentionally short.
Never repeat a field that is already present. Never restart qualification.
Never invent prices, deposits, ROI, profits, performance, testimonials or scarcity.
If a commercial fact is unknown, say the team can confirm it.

PROFILE:
Interest: ${user.interest || "Unknown"}
Market: ${user.market || "Unknown"}
Trading type: ${user.trading_type || "Unknown"}
Capital: ${user.capital || "Unknown"}
Experience: ${user.experience || "Unknown"}
Requirement: ${user.requirement || user.interest || "Unknown"}

CURRENT STEP: ${step}
USER MESSAGE: ${latest}

Reply only to the user's message. Do not ask more than one short question.
`;
}

function buildPostQualificationPrompt(user, latest) {
  return `
You are the personal sales consultant for MultiQuant Academy.

Language: ${languageInstruction(user.language)}

The lead is ALREADY QUALIFIED.
Do NOT restart qualification.
Do NOT say "Perfect — your requirement is clear" again unless the user is actually asking to reconnect.
Do NOT repeat the team handoff every time.
Answer the user's current question naturally.

KNOWN PROFILE:
Interest: ${user.interest}
Market: ${user.market}
Trading Type: ${user.trading_type}
Capital: ${user.capital}
Experience: ${user.experience}
Requirement: ${user.requirement}
Assigned Team: ${user.team_referred || "Not recorded"}

BUSINESS FACT SAFETY:
Never invent prices, subscriptions, minimum deposits, returns, profits,
performance, testimonials or availability. If a current price is not in
the approved business facts, say the team can confirm the current pricing.

USER MESSAGE:
${latest}

Return a concise, natural reply only.
`;
}

function shouldUpdateLanguage(text) {
  const normalized = String(text || "").trim().toLowerCase();
  const neutral = ["yes", "no", "ok", "okay", "y", "n", "haan", "ha", "han", "nahi", "nahin", "hmm", "hi", "hello", "thanks", "thank you"];
  return neutral.indexOf(normalized) < 0 && normalized.length >= 2;
}

function languageInstruction(language) {
  if (language === "Hindi") {
    return "Use natural Hindi in Devanagari.";
  }

  if (language === "Hinglish") {
    return "Use natural Hinglish in Roman script. Do not convert it into pure Devanagari Hindi.";
  }

  return "Use natural English.";
}

function generateSalesAI(env, prompt) {
  return generateGemini(env, prompt);
}

async function generateGemini(env, prompt) {
  if (!env.GEMINI_API_KEY) {
    return "I’m temporarily unable to connect to the AI service. Please try again shortly.";
  }

  const primaryModel = getEnv(env, "GEMINI_MODEL", DEFAULTS.GEMINI_MODEL);
  const fallbackModel1 = getEnv(env, "GEMINI_FALLBACK_MODEL", "gemini-3.7-flash");
  const fallbackModel2 = getEnv(env, "GEMINI_FALLBACK_MODEL_2", "gemini-3.5-flash");
  const fallbackModel3 = getEnv(env, "GEMINI_FALLBACK_MODEL_3", "gemini-3.1-flash-lite");
  const models = [
    primaryModel,
    fallbackModel1,
    fallbackModel2,
    fallbackModel3
  ].filter((model, index, list) =>
    model && list.indexOf(model) === index
  );

  const requestBody = {
    system_instruction: {
      parts: [{
        text:
          "You are a professional multilingual sales consultant. " +
          "Never invent commercial facts. Never guarantee trading outcomes."
      }]
    },
    contents: [{
      role: "user",
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      maxOutputTokens: 500
    }
  };

  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    const endpoint =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent";

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify(requestBody)
      });
    } catch (error) {
      console.error("GEMINI FETCH ERROR", model, error);
      if (index < models.length - 1) {
        console.warn("GEMINI FALLBACK", JSON.stringify({ from: model, to: models[index + 1] }));
        continue;
      }
      break;
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("GEMINI ERROR", model, response.status, errorText);

      // 429/5xx are transient provider/routing failures. Try the fallback model
      // immediately instead of showing an AI connection error to the user.
      const retryable = [429, 500, 502, 503, 504].includes(response.status);
      if (retryable && index < models.length - 1) {
        console.warn("GEMINI FALLBACK", JSON.stringify({
          from: model,
          to: models[index + 1],
          status: response.status
        }));
        continue;
      }

      break;
    }

    const data = await response.json();
    const candidates = data && data.candidates;
    if (!Array.isArray(candidates) || !candidates.length) {
      return "Tell me what you’re looking for and I’ll help you with the next step.";
    }

    const parts =
      candidates[0] &&
      candidates[0].content &&
      candidates[0].content.parts;

    if (!Array.isArray(parts)) {
      return "Tell me what you’re looking for and I’ll help you with the next step.";
    }

    let text = "";
    for (const part of parts) {
      if (part && part.text) text += part.text;
    }

    return text.trim() ||
      "Tell me what you’re looking for and I’ll help you with the next step.";
  }

  return "I’m having a temporary AI connection issue. Please try again in a moment.";
}

/* ============================================================
   QUALIFIED HANDOFF
============================================================ */

async function qualifyAndHandoff(env, userId, chatId) {
  const user = await getUser(env, userId);

  if (!qualificationComplete(user)) {
    const step = getQualificationStep(user);

    const response = await generateSalesAI(
      env,
      buildQualificationPrompt(
        user,
        "I want to continue.",
        step
      )
    );

    await saveMessage(env, userId, "assistant", response);
    await sendTelegram(env, chatId, response);
    return;
  }

  const team = assignedTeam(user);

  // Send the lead alert only once.
  if (user.lead_status !== "qualified" && user.lead_status !== "team_referred") {
    const teamChatId = getTeamAlertChatId(env, team);

    if (teamChatId) {
      await sendTelegram(
        env,
        teamChatId,
        buildLeadAlert(user, team),
        teamLeadKeyboard(user)
      );
    } else {
      console.warn(
        "No team alert chat configured for " + team.key +
        ". Set TEAM_ALERT_CHAT_ID or the team-specific chat ID."
      );
    }

    await updateUser(env, userId, {
      lead_status: "qualified",
      team_referred: team.username,
      followup_status: "stopped",
      last_interaction: now()
    });
  }

  const message =
    "✅ *Got it — your details are saved.*\n\n" +
    "🎯 Interest: *" + escapeMarkdown(user.interest || "Trading") + "*\n" +
    "📊 Trading: *" + escapeMarkdown(user.trading_type || "Not specified") + "*\n\n" +
    "I’m connecting you with the right team now. They can take it from here and answer the current options/onboarding details. 👇";

  await sendTelegram(env, chatId, message, teamHandoffKeyboard(team));
}

function assignedTeam(user) {
  const interest = String(user.interest || "").toLowerCase();
  const market = String(user.market || "").toLowerCase();

  if (
    interest.indexOf("crypto") >= 0 ||
    market.indexOf("crypto") >= 0
  ) {
    return {
      key: "crypto",
      label: "Crypto Team",
      username: getEnvPlaceholder("CRYPTO_TEAM", DEFAULTS.CRYPTO_TEAM)
    };
  }

  if (
    interest.indexOf("stock") >= 0 ||
    market.indexOf("stock") >= 0
  ) {
    return {
      key: "stocks",
      label: "Indian Stock Market Team",
      username: getEnvPlaceholder("STOCK_TEAM", DEFAULTS.STOCK_TEAM)
    };
  }

  return {
    key: "forex",
    label: "Forex Team",
    username: getEnvPlaceholder("FOREX_TEAM", DEFAULTS.FOREX_TEAM)
  };
}

function getTeamAlertChatId(env, team) {
  if (env.TEAM_ALERT_CHAT_ID) return String(env.TEAM_ALERT_CHAT_ID);

  if (team.key === "crypto" && env.CRYPTO_TEAM_CHAT_ID) {
    return String(env.CRYPTO_TEAM_CHAT_ID);
  }

  if (team.key === "forex" && env.FOREX_TEAM_CHAT_ID) {
    return String(env.FOREX_TEAM_CHAT_ID);
  }

  if (team.key === "stocks" && env.STOCK_TEAM_CHAT_ID) {
    return String(env.STOCK_TEAM_CHAT_ID);
  }

  return String(env.ADMIN_CHAT_ID || "");
}

function buildLeadAlert(user, team) {
  return (
    "🚨 *NEW QUALIFIED LEAD*\n\n" +
    "👤 Name: " + escapeMarkdown(user.first_name || "Unknown") + "\n" +
    "🔗 Username: " +
      (user.username ? "@" + escapeMarkdown(user.username) : "Not available") + "\n" +
    "🆔 Telegram ID: " + escapeMarkdown(String(user.telegram_id)) + "\n\n" +
    "🎯 Interest: " + escapeMarkdown(user.interest || "Unknown") + "\n" +
    "📊 Market: " + escapeMarkdown(user.market || "Unknown") + "\n" +
    "🤝 Trading Type: " + escapeMarkdown(user.trading_type || "Unknown") + "\n" +
    "💰 Capital: " + escapeMarkdown(user.capital || "Unknown") + "\n" +
    "📈 Experience: " + escapeMarkdown(user.experience || "Unknown") + "\n" +
    "🎯 Requirement: " + escapeMarkdown(user.requirement || "Unknown") + "\n\n" +
    "🗣 Language: " + escapeMarkdown(user.language || "English") + "\n" +
    "👥 Assigned Team: " + escapeMarkdown(team.username) + "\n" +
    "📌 Status: QUALIFIED\n" +
    "⏱ " + new Date().toISOString()
  );
}

function teamLeadKeyboard(user) {
  const rows = [];

  if (user.username) {
    rows.push([{
      text: "💬 Open Lead Chat",
      url: "https://t.me/" + stripAt(user.username)
    }]);
  } else {
    // The tg://user?id= link is supported in inline keyboard buttons when the
    // bot has previously received a private interaction/callback from the user.
    rows.push([{
      text: "👤 Open Telegram Profile",
      url: "tg://user?id=" + String(user.telegram_id)
    }]);
  }

  return { inline_keyboard: rows };
}

function teamHandoffKeyboard(team) {
  return {
    inline_keyboard: [
      [{
        text: "💬 Chat With " + team.username,
        url: "https://t.me/" + stripAt(team.username)
      }],
      [{
        text: "❓ I Have More Questions",
        callback_data: "more_questions"
      }],
      [{
        text: "🔕 Not Interested",
        callback_data: "not_interested"
      }]
    ]
  };
}

function existingTeamKeyboard(user) {
  if (!user.team_referred) return null;

  return {
    inline_keyboard: [
      [{
        text: "💬 Chat With " + user.team_referred,
        url: "https://t.me/" + stripAt(user.team_referred)
      }]
    ]
  };
}

/* ============================================================
   LEAD FACT EXTRACTION
============================================================ */

function extractLeadFacts(text, user) {
  const value = String(text || "");
  const lower = value.toLowerCase();
  const result = {};

  if (containsAny(lower, ["crypto", "bitcoin", "btc", "altcoin"])) {
    result.market = "Crypto";

    if (containsAny(lower, ["copy trading", "copy trade", "copy-trading"])) {
      result.interest = "Crypto Copy Trading";
      result.trading_type = "Copy Trading";
    } else if (containsAny(lower, ["signal", "signals"])) {
      result.interest = "Crypto Premium Signals";
      result.trading_type = "Self Trading";
    }
  }

  if (containsAny(lower, ["forex", "xauusd", "gold"])) {
    result.market = "Forex";

    if (containsAny(lower, ["copy trading", "copy trade", "copy-trading"])) {
      result.interest = "Forex Copy Trading";
      result.trading_type = "Copy Trading";
    } else if (!user || !user.interest) {
      result.interest = "Forex Trading";
    }
  }

  if (
    containsAny(lower, [
      "stock market",
      "indian stock",
      "nifty",
      "sensex"
    ])
  ) {
    result.market = "Indian Stocks";
    result.interest = "Indian Stock Market";
    result.trading_type = "Self Trading";
  }

  if (containsAny(lower, ["copy trading", "copy trade", "copy-trading"])) {
    result.trading_type = "Copy Trading";
  } else if (containsAny(lower, ["signals", "signal"])) {
    result.trading_type = "Self Trading";
  } else if (
    containsAny(lower, [
      "self trading",
      "trade myself",
      "i will trade",
      "main khud trade"
    ])
  ) {
    result.trading_type = "Self Trading";
  }

  if (
    containsAny(lower, [
      "complete beginner",
      "beginner",
      "new to trading",
      "never traded",
      "i am new",
      "im new"
    ])
  ) {
    result.experience = "Beginner";
  } else if (
    containsAny(lower, [
      "intermediate",
      "some experience"
    ])
  ) {
    result.experience = "Intermediate";
  } else if (
    containsAny(lower, [
      "experienced",
      "expert",
      "years of trading"
    ])
  ) {
    result.experience = "Experienced";
  }

  const capital = extractCapital(value);
  if (capital) result.capital = capital;

  if (
    value.length >= 10 &&
    containsAny(lower, [
      "want",
      "looking",
      "need",
      "chahiye",
      "kaise start",
      "start",
      "help",
      "requirement",
      "goal"
    ])
  ) {
    result.requirement = value.slice(0, 600);
  }

  return result;
}

function extractCapital(text) {
  const lower = String(text || "")
    .toLowerCase()
    .replaceAll(",", " ")
    .replaceAll("  ", " ");

  // Explicit currencies/financial context.
  if (
    containsAny(lower, [
      "usdt",
      "usd",
      "dollar",
      "dollars",
      "capital",
      "budget",
      "investment",
      "amount"
    ])
  ) {
    const number = firstNumber(lower);
    if (number) {
      return number + " " + detectCurrency(lower);
    }
  }

  // 2k / 5k / 10k.
  const tokens = lower.split(/\s+/);
  for (const token of tokens) {
    if (token.length > 1 && token.endsWith("k")) {
      const numeric = token.slice(0, -1);
      if (isNumeric(numeric)) return numeric + "k";
    }
  }

  // "mere pass 2000 hai", "mere paas 2000 hai kaise start kru"
  if (
    containsAny(lower, [
      "mere pass",
      "mere paas",
      "have",
      "start",
      "capital",
      "budget",
      "investment",
      "amount"
    ])
  ) {
    const number = firstNumber(lower);
    if (number) return number + " USDT";
  }

  return "";
}

function firstNumber(text) {
  const chunks = String(text || "").split(/[^0-9.]+/);

  for (const chunk of chunks) {
    if (chunk && isNumeric(chunk)) return chunk;
  }

  return "";
}

function isNumeric(value) {
  if (!value) return false;
  const number = Number(value);
  return Number.isFinite(number);
}

function detectCurrency(text) {
  if (text.indexOf("usdt") >= 0) return "USDT";
  if (
    text.indexOf("usd") >= 0 ||
    text.indexOf("dollar") >= 0
  ) {
    return "USD";
  }
  return "USDT";
}

/* ============================================================
   LANGUAGE
============================================================ */

function detectLanguage(text) {
  const value = String(text || "");

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code >= 0x0900 && code <= 0x097F) {
      return "Hindi";
    }
  }

  const lower = value.toLowerCase();

  const hinglishWords = [
    "bhai",
    "hai",
    "kya",
    "kaise",
    "mujhe",
    "aap",
    "apna",
    "chahiye",
    "karna",
    "krna",
    "nahi",
    "haan",
    "acha",
    "accha",
    "kitna",
    "paisa",
    "lakh",
    "crore",
    "mere",
    "pass",
    "batao",
    "btao",
    "karo",
    "kru"
  ];

  let hits = 0;

  for (const word of hinglishWords) {
    if (lower.indexOf(word) >= 0) hits++;
  }

  return hits > 0 ? "Hinglish" : "English";
}

/* ============================================================
   NEWS — RSS
============================================================ */

async function runNewsJob(env) {
  if (!isEnabled(env, "NEWS_ENABLED", true)) return;
  if (await hasRecentNewsPost(env, 30)) return;

  const feeds = getNewsFeeds(env);
  if (!feeds.length) return;

  const collected = [];
  const seenLinks = new Set();

  for (const feedUrl of feeds) {
    try {
      const response = await fetch(feedUrl, {
        headers: { "User-Agent": "MultiQuant-Academy-NewsBot/3.0" }
      });
      if (!response.ok) continue;
      const xml = await response.text();
      const items = parseRssItems(xml);
      for (const item of items.slice(0, 5)) {
        if (!item.title || !item.link || seenLinks.has(item.link)) continue;
        seenLinks.add(item.link);
        collected.push(Object.assign({}, item, { feed: feedUrl }));
      }
    } catch (error) {
      console.error("NEWS FEED ERROR", feedUrl, error);
    }
  }

  for (const item of collected) {
    const key = "news:" + simpleHash(item.link);
    if (await hasMeta(env, key)) continue;

    // Reject obvious low-value/general stories before spending a Gemini request.
    if (!isImpactfulNewsCandidate(item)) continue;

    try {
      const prompt =
        "Return ONLY valid JSON with exactly these keys: headline, summary, impact. " +
        "headline: short and punchy, max 12 words. " +
        "summary: 1-2 short factual sentences, max 35 words. " +
        "impact: one short sentence, max 22 words, use may/could and never guarantee. " +
        "Do not invent facts. If this is not materially relevant to crypto, markets, " +
        "forex, stocks, commodities, rates, macroeconomics or major finance, return null.\n\n" +
        "Title: " + item.title + "\n" +
        "Summary: " + item.description;

      const rewritten = await generateGemini(env, prompt);
      if (!rewritten || rewritten.indexOf("I’m having a temporary") >= 0 || rewritten.indexOf("I’m temporarily unable") >= 0) continue;

      let parsed;
      try {
        parsed = JSON.parse(rewritten);
      } catch (error) {
        const cleaned = rewritten.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        try { parsed = JSON.parse(cleaned); } catch (e) { parsed = null; }
      }
      if (!parsed || !parsed.headline || !parsed.summary || !parsed.impact) continue;

      const finalText =
        "📰 *" + escapeMarkdown(parsed.headline) + "*\n\n" +
        escapeMarkdown(parsed.summary) + "\n\n" +
        "📊 *Market Impact*\n" +
        escapeMarkdown(parsed.impact) + "\n\n" +
        "[🔗 Source](" + item.link.replace(/[)\\]/g, "") + ")";

      const sent = await sendNewsChannel(env, finalText);
      if (sent) {
        await setMeta(env, key, "1");
        await setMeta(env, "news:last_published", String(Date.now()));
      }
      return;
    } catch (error) {
      console.error("NEWS ITEM ERROR", error);
    }
  }
}

async function hasRecentNewsPost(env, minutes) {
  if (!env.DB) return false;
  const value = await getMeta(env, "news:last_published");
  if (!value) return false;
  return (Date.now() - Number(value)) < (Number(minutes) * 60000);
}

function isImpactfulNewsCandidate(item) {
  const text = (String(item.title || "") + " " + String(item.description || "")).toLowerCase();
  const keywords = [
    "bitcoin", "btc", "ethereum", "crypto", "fed", "federal reserve", "ecb", "boe",
    "boj", "interest rate", "inflation", "cpi", "ppi", "nfp", "jobs", "gdp", "recession",
    "tariff", "trade war", "etf", "sec", "regulation", "bank", "oil", "gold", "treasury",
    "yield", "stock market", "nasdaq", "s&p", "dow", "earnings", "blackrock", "reuters"
  ];
  return keywords.some(function(k) { return text.indexOf(k) >= 0; });
}

function getNewsFeeds(env) {
  if (env.NEWS_FEEDS_JSON) {
    try {
      const parsed = JSON.parse(env.NEWS_FEEDS_JSON);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (error) {
      console.error("NEWS_FEEDS_JSON invalid; using built-in feeds");
    }
  }

  // Built-in sources so the news module works without another environment variable.
  // Failed/unavailable feeds are skipped; duplicate links are protected by D1.
  return [
    "https://cointelegraph.com/rss",
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "https://news.bitcoin.com/feed/",
    "https://www.investing.com/rss/news_1.rss",
    "https://www.investing.com/rss/news_285.rss",
    "https://www.investing.com/rss/news_14.rss",
    "https://www.investing.com/rss/news_301.rss",
    "https://feeds.marketwatch.com/marketwatch/topstories/",
    "https://www.ft.com/?format=rss",
    "https://feeds.bbci.co.uk/news/business/rss.xml",
    "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "https://news.google.com/rss/search?q=site%3Ablackrock.com+investment+OR+markets+when%3A1d&hl=en-US&gl=US&ceid=US%3Aen",
    "https://news.google.com/rss/search?q=site%3Areuters.com+markets+OR+economy+OR+finance+when%3A1d&hl=en-US&gl=US&ceid=US%3Aen"
  ];
}

function parseRssItems(xml) {
  const items = [];
  const blocks = String(xml || "").split("<item>");

  for (let i = 1; i < blocks.length && items.length < 10; i++) {
    const block = blocks[i];

    const title = cleanXmlText(extractXmlTag(block, "title"));
    const link = cleanXmlText(
      extractXmlTag(block, "link") ||
      extractXmlTag(block, "guid")
    );
    const description = cleanXmlText(
      extractXmlTag(block, "description")
    );

    if (title && link) {
      items.push({
        title: title,
        link: link,
        description: description
      });
    }
  }

  return items;
}

function extractXmlTag(block, tag) {
  const open = "<" + tag + ">";
  const close = "</" + tag + ">";
  const start = block.indexOf(open);

  if (start < 0) return "";

  const end = block.indexOf(close, start + open.length);
  if (end < 0) return "";

  return block.slice(start + open.length, end);
}

function cleanXmlText(value) {
  return String(value || "")
    .replaceAll("<![CDATA[", "")
    .replaceAll("]]>", "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

/* ============================================================
   ECONOMIC EVENTS
============================================================ */

async function runEconomicJob(env) {
  if (!isEnabled(env, "ECONOMIC_ENABLED", true)) return;

  try {
    const events = await fetchBuiltInEconomicEvents(env);
    if (!events.length) {
      console.log("ECONOMIC: no events returned");
      return;
    }

    for (const event of events.slice(0, 100)) {
      if (!isHighImpactEconomicEvent(event)) continue;

      const timestamp = eventTimestamp(event);
      if (!Number.isFinite(timestamp)) continue;

      const minutes = Math.round((timestamp - Date.now()) / 60000);

      if (minutes <= 365 && minutes >= 335) {
        await publishEconomic(env, event, "6H");
      }

      if (minutes <= 7 && minutes >= 0) {
        await publishEconomic(env, event, "5M");
      }

      // Release window. This assumes the API updates actual after release.
      if (minutes <= 0 && minutes >= -10) {
        await publishEconomic(env, event, "RELEASED");
      }
    }
  } catch (error) {
    console.error("ECONOMIC JOB ERROR", error);
  }
}

async function fetchBuiltInEconomicEvents(env) {
  // Preferred: financecalendar.com public JSON endpoint (no API key).
  // Fallback: ForexFactory weekly JSON export.
  const now = new Date();
  const from = now.toISOString().slice(0, 10);
  const future = new Date(now.getTime() + 8 * 86400000);
  const to = future.toISOString().slice(0, 10);

  try {
    const url =
      "https://www.financecalendar.com/wp-json/fc/v1/calendar?from=" +
      encodeURIComponent(from) + "&to=" + encodeURIComponent(to) +
      "&impact=high&limit=500";
    const r = await fetch(url, { headers: { "User-Agent": "MultiQuant-Academy-EconomicBot/1.0" } });
    if (r.ok) {
      const payload = await r.json();
      const arr = normalizeEconomicEvents(payload);
      if (arr.length) return arr;
    }
  } catch (e) {
    console.error("ECONOMIC primary source error", e);
  }

  try {
    const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
      headers: { "User-Agent": "MultiQuant-Academy-EconomicBot/1.0" }
    });
    if (r.ok) return await r.json();
  } catch (e) {
    console.error("ECONOMIC fallback source error", e);
  }

  return [];
}

function normalizeEconomicEvents(payload) {
  if (Array.isArray(payload)) return payload;

  if (payload && Array.isArray(payload.events)) {
    return payload.events;
  }

  if (payload && Array.isArray(payload.data)) {
    return payload.data;
  }

  if (payload && payload.results && Array.isArray(payload.results)) {
    return payload.results;
  }

  return [];
}

function isHighImpactEconomicEvent(event) {
  const impact = String(
    event.impact || event.importance || event.priority || ""
  ).toLowerCase();

  if (
    impact === "high" ||
    impact === "3" ||
    impact === "major"
  ) {
    return true;
  }

  const title = String(
    event.name || event.title || event.event || ""
  ).toLowerCase();

  const keywords = [
    "fomc",
    "fed interest rate",
    "federal funds",
    "cpi",
    "core cpi",
    "ppi",
    "nfp",
    "nonfarm",
    "unemployment",
    "gdp",
    "pce",
    "retail sales",
    "pmi",
    "ecb",
    "boe",
    "boj"
  ];

  for (const word of keywords) {
    if (title.indexOf(word) >= 0) return true;
  }

  return false;
}

function eventTimestamp(event) {
  const raw =
    event.release_time ||
    event.releaseTime ||
    event.timestamp ||
    event.time ||
    event.date;

  if (!raw) return NaN;

  if (typeof raw === "number") {
    return raw < 10000000000 ? raw * 1000 : raw;
  }

  const timestamp = Date.parse(String(raw));
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

async function publishEconomic(env, event, stage) {
  const name = String(
    event.name || event.title || event.event || "Economic Event"
  );

  const rawTime =
    event.release_time ||
    event.releaseTime ||
    event.timestamp ||
    event.time ||
    event.date;

  const key =
    "econ:" +
    simpleHash(
      name + "|" +
      String(rawTime) + "|" +
      stage
    );

  if (await hasMeta(env, key)) return;

  let text = "";

  if (stage === "6H") {
    text =
      "🚨 *HIGH-IMPACT ECONOMIC EVENT*\n\n" +
      "📌 " + escapeMarkdown(name) + "\n" +
      "⏰ " + escapeMarkdown(String(rawTime)) + "\n\n" +
      "This event may increase market volatility. " +
      "Manage risk carefully around the release.";

  } else if (stage === "5M") {
    text =
      "⚠️ *5 MINUTES TO HIGH-IMPACT EVENT*\n\n" +
      "📌 " + escapeMarkdown(name) + "\n" +
      "⏰ " + escapeMarkdown(String(rawTime)) + "\n\n" +
      "Possible volatility ahead.";
  } else {
    const actual = event.actual ?? event.value ?? "N/A";
    const forecast = event.forecast ?? event.consensus ?? "N/A";
    const previous = event.previous ?? "N/A";

    const analysis = await generateGemini(
      env,
      "Explain the possible market impact of this economic release. " +
      "Use cautious language such as may/could. Do not predict certainty. " +
      "Do not invent missing facts.\n\n" +
      "Event: " + name + "\n" +
      "Actual: " + actual + "\n" +
      "Forecast: " + forecast + "\n" +
      "Previous: " + previous
    );

    text =
      "📊 *ECONOMIC DATA RELEASED*\n\n" +
      "📌 " + escapeMarkdown(name) + "\n\n" +
      "Actual: " + escapeMarkdown(String(actual)) + "\n" +
      "Forecast: " + escapeMarkdown(String(forecast)) + "\n" +
      "Previous: " + escapeMarkdown(String(previous)) + "\n\n" +
      "🧠 *Potential Market Impact*\n" +
      analysis;
  }

  await sendPublicChannel(env, text);
  await setMeta(env, key, "1");
}

/* ============================================================
   CRYPTO SIGNALS — OKX USDT PERPETUALS
============================================================ */

async function getOkxTickers(env) {
  // Fetch the current USDT perpetual instrument list, then take a short-lived
  // public OKX WebSocket snapshot in the Worker itself. Do NOT keep this stream
  // inside the Durable Object: OKX ticker messages are billed as Durable Object
  // requests on the Workers Free plan and can exhaust the daily DO allowance.
  const wsUrl = getEnv(env, "OKX_PUBLIC_WS_URL", "wss://ws.okx.com/ws/v5/public");
  let instrumentIds = [];

  try {
    const response = await fetch(
      "https://www.okx.com/api/v5/public/instruments?instType=SWAP",
      { method: "GET", headers: { "Accept": "application/json" } }
    );
    if (!response.ok) {
      console.error("OKX TICKER INSTRUMENTS ERROR", response.status, await response.text());
      return null;
    }

    const payload = await response.json();
    instrumentIds = Array.isArray(payload.data)
      ? payload.data
          .filter(item => item && item.instType === "SWAP" && typeof item.instId === "string" && item.instId.endsWith("-USDT-SWAP"))
          .map(item => item.instId)
      : [];
    instrumentIds = Array.from(new Set(instrumentIds));

    console.log("OKX TICKER INSTRUMENTS LOADED", JSON.stringify({ count: instrumentIds.length }));
    if (!instrumentIds.length) return null;
  } catch (error) {
    console.error("OKX TICKER INSTRUMENTS FETCH ERROR", error);
    return null;
  }

  return await new Promise((resolve) => {
    let ws = null;
    let settled = false;
    const tickerMap = new Map();
    const timeoutMs = 7000;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { clearTimeout(timer); } catch (_) {}
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, "snapshot-complete");
      } catch (_) {}
      const tickers = Array.from(tickerMap.values());
      console.log("OKX TICKER WS SNAPSHOT", JSON.stringify({ count: tickers.length, requested: instrumentIds.length }));
      resolve(result === false ? null : (tickers.length ? tickers : null));
    };

    const timer = setTimeout(() => finish(), timeoutMs);

    try {
      ws = new WebSocket(wsUrl);

      ws.addEventListener("open", () => {
        try {
          const batchSize = 100;
          let sent = 0;
          for (let i = 0; i < instrumentIds.length; i += batchSize) {
            const args = instrumentIds.slice(i, i + batchSize).map(instId => ({
              channel: "tickers",
              instId
            }));
            ws.send(JSON.stringify({ op: "subscribe", args }));
            sent += args.length;
          }
          console.log("OKX TICKER WS TICKERS SUBSCRIBED", JSON.stringify({ count: sent, batchSize }));
        } catch (error) {
          console.error("OKX TICKER WS SUBSCRIBE ERROR", error);
          finish(false);
        }
      });

      ws.addEventListener("message", (event) => {
        try {
          if (typeof event.data === "string" && event.data.toLowerCase() === "ping") {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send("pong");
            return;
          }

          const message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
          if (!message) return;
          if (message.event === "error") {
            console.error("OKX TICKER WS EVENT ERROR", message);
            return;
          }
          if (message.arg && message.arg.channel === "tickers" && Array.isArray(message.data)) {
            for (const ticker of message.data) {
              if (ticker && ticker.instId) tickerMap.set(ticker.instId, ticker);
            }
            if (tickerMap.size >= instrumentIds.length) finish();
          }
        } catch (error) {
          console.error("OKX TICKER WS MESSAGE ERROR", error);
        }
      });

      ws.addEventListener("error", (error) => {
        console.error("OKX TICKER WS ERROR", {
          type: error && error.type,
          message: error && error.message,
          readyState: ws ? ws.readyState : null
        });
        finish(false);
      });

      ws.addEventListener("close", () => {
        if (!settled) finish();
      });
    } catch (error) {
      console.error("OKX TICKER WS CONNECT ERROR", error);
      finish(false);
    }
  });
}

async function runSignalJob(env, tickers) {
  console.log("SIGNAL SCAN START", JSON.stringify({
    enabled: isEnabled(env, "SIGNALS_ENABLED", true),
    db: !!env.DB,
    tickers: Array.isArray(tickers) ? tickers.length : 0
  }));
  if (!isEnabled(env, "SIGNALS_ENABLED", true)) return;
  if (!env.DB) return;
  if (!Array.isArray(tickers) || !tickers.length) {
    console.warn("SIGNAL SCAN SKIP NO_TICKERS");
    return;
  }

  try {
    const quota = await getSignalQuota(env);
    if (!quota.allowed) {
      console.log("SIGNAL QUOTA BLOCK", JSON.stringify(quota));
      return;
    }

    const usdt = tickers.filter(function(item) {
      return item &&
        typeof item.instId === "string" &&
        item.instId.endsWith("-USDT-SWAP") &&
        Number(item.vol24h || 0) > 0 &&
        Number(item.last || 0) > 0;
    });

    console.log("SIGNAL USDT FILTER", JSON.stringify({ input: tickers.length, usdt: usdt.length }));
    if (!usdt.length) {
      console.warn("SIGNAL SCAN SKIP NO_USDT_SWAPS");
      return;
    }

    usdt.sort(function(a, b) {
      const aChange = pct24h(a);
      const bChange = pct24h(b);
      const av = Number.isFinite(aChange) ? Math.abs(aChange) : 0;
      const bv = Number.isFinite(bChange) ? Math.abs(bChange) : 0;
      const aq = Math.log10(Number(a.volCcy24h || a.vol24h || 0) + 10);
      const bq = Math.log10(Number(b.volCcy24h || b.vol24h || 0) + 10);
      return (bv * bq) - (av * aq);
    });

    const setups = [];
    const maxCandidates = Math.min(usdt.length, 20);

    for (let i = 0; i < maxCandidates; i++) {
      const setup = await buildOkxSetup(usdt[i]);
      if (setup) setups.push(setup);
    }

    setups.sort(function(a, b) { return b.score - a.score; });
    console.log("SIGNAL SETUPS FOUND", JSON.stringify({
      count: setups.length,
      best: setups.length ? { symbol: setups[0].symbol, direction: setups[0].direction, score: setups[0].score } : null
    }));
    const selected = setups.slice(0, 1);

    for (const setup of selected) {
      const quotaNow = await getSignalQuota(env);
      if (!quotaNow.allowed) {
        console.log("SIGNAL QUOTA BLOCK BEFORE SEND", JSON.stringify(quotaNow));
        break;
      }

      // Never open another live position for the same symbol.
      if (await hasOpenSignalForSymbol(env, setup.symbol)) {
        console.log("SIGNAL OPEN POSITION BLOCK", setup.symbol);
        continue;
      }

      const hourKey = Math.floor(Date.now() / 3600000);
      const eventKey = "open:" + setup.symbol + ":" + setup.direction + ":" + hourKey;
      if (!(await claimSignalEvent(env, eventKey))) continue;

      try {
        const text =
          "📈 *CRYPTO FUTURES SIGNAL (USDT-M)*\n\n" +
          "Pair: `" + setup.pair + "`\n" +
          "Direction: *" + setup.direction + "*\n" +
          "Leverage: *10X*\n\n" +
          "Entry: `" + setup.entry + "`\n\n" +
          "TP1: `" + setup.tp1 + "` — " + setup.tp1Pct + "%\n" +
          "TP2: `" + setup.tp2 + "` — " + setup.tp2Pct + "%\n" +
          "TP3: `" + setup.tp3 + "` — " + setup.tp3Pct + "%\n\n" +
          "SL: `" + setup.sl + "`\n\n" +
          "_⚠️ Move your SL to entry after the first target is hit._\n\n" +
          "_📊 Trade Setup: " + setup.tradeSetup + " — " + setup.timeframe + "_\n\n" +
          "#BTCUSDT #BTC #CRYPTO #" + setup.coinTag;

        const sent = await sendPublicChannel(env, text);
        if (sent && sent.message_id) {
          await createSignalPosition(env, setup, sent.message_id);
          await recordSignalHistory(env, setup, sent.message_id);
          await setMeta(env, "signal:okx:" + setup.symbol + ":" + setup.direction + ":" + hourKey, "1");
        } else {
          await releaseSignalEvent(env, eventKey);
        }
      } catch (error) {
        await releaseSignalEvent(env, eventKey);
        throw error;
      }
    }
  } catch (error) {
    console.error("OKX SIGNAL JOB ERROR", error);
  }
}

async function ensureSignalHistory(env) {
  if (!env.DB) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS signal_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      pair TEXT NOT NULL,
      direction TEXT NOT NULL,
      channel_message_id INTEGER,
      sent_at TEXT NOT NULL
    )
  `).run();
}

async function getSignalQuota(env) {
  await ensureSignalHistory(env);

  const max24h = Number(
    getEnv(env, "SIGNAL_MAX_24H", String(DEFAULTS.SIGNAL_MAX_24H))
  );

  const minGap = Number(
    getEnv(env, "SIGNAL_MIN_GAP_MINUTES", String(DEFAULTS.SIGNAL_MIN_GAP_MINUTES))
  );

  const countRow = await env.DB.prepare(`
    SELECT COUNT(*) AS count24h
    FROM signal_history
    WHERE sent_at >= datetime('now', '-24 hours')
  `).first();

  const lastRow = await env.DB.prepare(`
    SELECT sent_at
    FROM signal_history
    ORDER BY id DESC
    LIMIT 1
  `).first();

  const count24h = Number(countRow && countRow.count24h || 0);

  const rawLast = lastRow && lastRow.sent_at
    ? String(lastRow.sent_at)
    : "";

  const normalizedLast = rawLast
    ? rawLast.replace(" ", "T")
    : "";

  const lastTime = normalizedLast
    ? Date.parse(
        /[zZ]|[+-]\d{2}:\d{2}$/.test(normalizedLast)
          ? normalizedLast
          : `${normalizedLast}Z`
      )
    : 0;

  const minutesSinceLast = lastTime
    ? (Date.now() - lastTime) / 60000
    : Infinity;

  const allowed = count24h < max24h && minutesSinceLast >= minGap;

  return {
    allowed: allowed,
    count24h: count24h,
    max24h: max24h,
    minGapMinutes: minGap,
    minutesSinceLast: Number.isFinite(minutesSinceLast)
      ? Number(minutesSinceLast.toFixed(1))
      : null
  };
}

async function recordSignalHistory(env, setup, messageId) {
  await ensureSignalHistory(env);

  const symbol = String(setup && setup.symbol || "").trim();
  const pair = String(
    setup && setup.pair
      ? setup.pair
      : `${symbol}/USDT`
  ).trim();
  const direction = String(setup && setup.direction || "").trim();

  await env.DB.prepare(`
    INSERT INTO signal_history
      (symbol, pair, direction, channel_message_id, sent_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).bind(
    symbol,
    pair,
    direction,
    Number(messageId)
  ).run();
}

async function ensureSignalEventGuard(env) {
  if (!env.DB) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS signal_event_guard (
      event_key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function claimSignalEvent(env, eventKey) {
  if (!env.DB || !eventKey) return false;
  try {
    await ensureSignalEventGuard(env);
    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO signal_event_guard (event_key, created_at)
      VALUES (?, CURRENT_TIMESTAMP)
    `).bind(String(eventKey)).run();
    return Number(result && result.meta && result.meta.changes || 0) === 1;
  } catch (error) {
    console.error("SIGNAL EVENT CLAIM ERROR", eventKey, error);
    return false;
  }
}

async function releaseSignalEvent(env, eventKey) {
  if (!env.DB || !eventKey) return;
  try {
    await env.DB.prepare(`DELETE FROM signal_event_guard WHERE event_key = ?`).bind(String(eventKey)).run();
  } catch (error) {
    console.error("SIGNAL EVENT RELEASE ERROR", eventKey, error);
  }
}

async function hasOpenSignalForSymbol(env, symbol) {
  if (!env.DB || !symbol) return false;
  const row = await env.DB.prepare(`
    SELECT id FROM signal_positions
    WHERE symbol = ? AND status IN ('OPEN','CLOSING')
    ORDER BY id DESC LIMIT 1
  `).bind(String(symbol)).first();
  return !!row;
}

async function createSignalPosition(env, setup, messageId) {
  if (!env.DB || !messageId) return;
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS signal_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        pair TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_mid REAL NOT NULL,
        sl_price REAL NOT NULL,
        tp1_price REAL NOT NULL,
        tp2_price REAL NOT NULL,
        tp3_price REAL NOT NULL,
        tp1_hit INTEGER DEFAULT 0,
        tp2_hit INTEGER DEFAULT 0,
        tp3_hit INTEGER DEFAULT 0,
        highest_price REAL,
        lowest_price REAL,
        status TEXT DEFAULT 'OPEN',
        channel_message_id INTEGER,
        created_at TEXT,
        updated_at TEXT
      )
    `).run();
    await env.DB.prepare(`
      INSERT INTO signal_positions
      (symbol,pair,direction,entry_mid,sl_price,tp1_price,tp2_price,tp3_price,highest_price,lowest_price,status,channel_message_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
    `).bind(
      setup.symbol, setup.pair, setup.direction, setup.entryMid, setup.slPrice,
      setup.tp1Price, setup.tp2Price, setup.tp3Price, setup.entryMid, setup.entryMid,
      "OPEN", Number(messageId)
    ).run();
  } catch (error) {
    console.error("SIGNAL POSITION CREATE ERROR", error);
  }
}

async function monitorOpenSignals(env, tickers) {
  if (!env.DB || !isEnabled(env, "SIGNALS_ENABLED", true)) return;
  try {
    await ensureSchema(env);
    const result = await env.DB.prepare("SELECT * FROM signal_positions WHERE status='OPEN' ORDER BY id ASC LIMIT 50").all();
    const positions = result?.results || [];
    if (!positions.length) return;
    const tickerMap = new Map((tickers || []).filter(x => x?.instId && Number(x.last) > 0).map(x => [x.instId, Number(x.last)]));

    for (const pos of positions) {
      const livePrice = tickerMap.get(pos.symbol);
      if (!(livePrice > 0)) continue;
      let highest = Number(pos.highest_price || pos.entry_mid);
      let lowest = Number(pos.lowest_price || pos.entry_mid);
      let tp1Hit = Number(pos.tp1_hit || 0), tp2Hit = Number(pos.tp2_hit || 0), tp3Hit = Number(pos.tp3_hit || 0);
      let candleHigh = livePrice, candleLow = livePrice;
      try {
        const r = await fetch("https://www.okx.com/api/v5/market/candles?instId=" + encodeURIComponent(pos.symbol) + "&bar=5m&limit=1");
        if (r.ok) {
          const d = await r.json(), c = Array.isArray(d.data) ? d.data[0] : null;
          if (Array.isArray(c) && c.length >= 5) {
            const h = Number(c[2]), l = Number(c[3]);
            if (h > 0 && l > 0) { candleHigh = Math.max(livePrice, h); candleLow = Math.min(livePrice, l); }
          }
        }
      } catch (e) { console.error("OKX POSITION CANDLE FETCH ERROR", pos.symbol, e); }

      highest = Math.max(highest, candleHigh, livePrice);
      lowest = Math.min(lowest, candleLow, livePrice);

      // Reconcile target state from the persistent favorable extreme. This is
      // the important recovery path after cron gaps, restart, or missed replies.
      const newlyReached = [];
      const checks = [
        ["TP1", "tp1_hit", Number(pos.tp1_price)],
        ["TP2", "tp2_hit", Number(pos.tp2_price)],
        ["TP3", "tp3_hit", Number(pos.tp3_price)]
      ];
      for (const [name, field, target] of checks) {
        if (Number(pos[field] || 0)) continue;
        const hit = pos.direction === "LONG" ? highest >= target : lowest <= target;
        if (!hit) continue;
        const claim = await env.DB.prepare(`UPDATE signal_positions SET ${field}=1, highest_price=?, lowest_price=?, updated_at=datetime('now') WHERE id=? AND status='OPEN' AND ${field}=0`).bind(highest, lowest, pos.id).run();
        if (Number(claim?.meta?.changes || 0) === 1) {
          pos[field] = 1;
          if (field === "tp1_hit") tp1Hit = 1;
          if (field === "tp2_hit") tp2Hit = 1;
          if (field === "tp3_hit") tp3Hit = 1;
          newlyReached.push({name, price: target});
        }
      }

      for (const hit of newlyReached) {
        const pct = Math.abs((Number(hit.price) - Number(pos.entry_mid)) / Number(pos.entry_mid)) * 1000;
        const msg = "🎯 *" + hit.name + " HIT*\n\n📌 " + pos.pair + " — " + pos.direction + "\n💰 Price: `" + reportFmt(hit.price) + "`\n📈 Profit: *+" + pct.toFixed(1) + "%*" + (hit.name === "TP1" ? "\n\n⚠️ SL is now protected at entry." : "");
        if (pos.channel_message_id) await sendTelegramReply(env, msg, pos.channel_message_id);
      }

      await env.DB.prepare("UPDATE signal_positions SET tp1_hit=?,tp2_hit=?,tp3_hit=?,highest_price=?,lowest_price=?,updated_at=datetime('now') WHERE id=? AND status='OPEN'").bind(tp1Hit, tp2Hit, tp3Hit, highest, lowest, pos.id).run();

      const anyTp = tp1Hit || tp2Hit || tp3Hit;
      let effectiveStop = Number(pos.sl_price);
      if (tp1Hit) effectiveStop = Number(pos.entry_mid);
      if (tp3Hit) {
        const entry = Number(pos.entry_mid);
        effectiveStop = pos.direction === "LONG"
          ? entry + (Math.max(0, highest - entry) * 0.80)
          : entry - (Math.max(0, entry - lowest) * 0.80);
      }
      const stopHit = pos.direction === "LONG" ? candleLow <= effectiveStop : candleHigh >= effectiveStop;
      if (!stopHit) continue;

      // A candle can prove that a stop was touched, but cannot prove whether
      // the stop or a target happened first. If TP3 was newly touched in this
      // same candle, wait for the next update rather than inventing the order.
      const tp3JustHit = newlyReached.some(x => x.name === "TP3");
      if (tp3JustHit) continue;

      const closePrice = effectiveStop;
      const realizedAtClose = reportMovePct(pos.direction, pos.entry_mid, closePrice);
      const peak = pos.direction === "LONG" ? highest : lowest;
      const peakPct = Math.max(0, reportMovePct(pos.direction, pos.entry_mid, peak) || 0);
      // Once any TP has been reached, the reported trade profit is the best
      // favorable move achieved by the position. Direct SL remains the actual
      // negative move at the SL price.
      const reportProfit = anyTp ? peakPct : realizedAtClose;
      const reason = anyTp ? "Trailing/Reversal" : "Direct SL";
      const closeClaim = await env.DB.prepare("UPDATE signal_positions SET status='CLOSING',updated_at=datetime('now') WHERE id=? AND status='OPEN'").bind(pos.id).run();
      if (Number(closeClaim?.meta?.changes || 0) !== 1) continue;

      const msg = anyTp
        ? "🔒 *SIGNAL CLOSED*\n\n📌 " + pos.pair + " — " + pos.direction + "\n\n💰 Closed Price: `" + reportFmt(closePrice) + "`\n📊 Profit: *+" + peakPct.toFixed(1) + "%*\n\n🏆 Highest Favorable Price: `" + reportFmt(peak) + "`\n🏆 Highest Profit: *+" + peakPct.toFixed(1) + "%*\n\n🎯 TP1 " + (tp1Hit?"✅":"❌") + "   TP2 " + (tp2Hit?"✅":"❌") + "   TP3 " + (tp3Hit?"✅":"❌")\n        : "😔 *SL HIT*\n\n📌 " + pos.pair + " — " + pos.direction + "\n\n💰 SL Price: `" + reportFmt(closePrice) + "`\n📉 Loss: *" + (realizedAtClose >= 0 ? "+" : "") + realizedAtClose.toFixed(1) + "%*\n\n🔒 Position Closed";
      try {
        if (pos.channel_message_id) await sendTelegramReply(env, msg, pos.channel_message_id);
      } finally {
        await env.DB.prepare("UPDATE signal_positions SET status='CLOSED',tp1_hit=?,tp2_hit=?,tp3_hit=?,highest_price=?,lowest_price=?,closed_at=datetime('now'),close_price=?,realized_profit_pct=?,highest_profit_pct=?,close_reason=?,updated_at=datetime('now') WHERE id=? AND status='CLOSING'").bind(tp1Hit,tp2Hit,tp3Hit,highest,lowest,closePrice,reportProfit,peakPct,reason,pos.id).run();
      }
    }
  } catch (error) { console.error("SIGNAL MONITOR ERROR", error); }
}

async function sendTelegramReply(env, text, replyToMessageId) {
  const channel = getEnv(env, "CHANNEL_CHAT_ID", DEFAULTS.CHANNEL_CHAT_ID);
  if (!channel || !env.TELEGRAM_BOT_TOKEN || !replyToMessageId) return false;

  const body = {
    chat_id: channel,
    text: text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_to_message_id: Number(replyToMessageId),
    allow_sending_without_reply: true
  };

  try {
    const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      console.error("TELEGRAM REPLY ERROR", await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error("TELEGRAM REPLY FETCH ERROR", error);
    return false;
  }
}

function pct24h(ticker) {
  const last = Number(ticker && ticker.last);
  const open = Number(ticker && ticker.open24h);
  if (!(last > 0) || !(open > 0)) return NaN;
  return ((last - open) / open) * 100;
}

async function buildOkxSetup(ticker) {
  try {
    const symbol = ticker.instId;
    const url =
      "https://www.okx.com/api/v5/market/candles?instId=" +
      encodeURIComponent(symbol) + "&bar=15m&limit=60";

    const response = await fetch(url);
    if (!response.ok) return null;

    const payload = await response.json();
    const candles = Array.isArray(payload.data) ? payload.data.slice().reverse() : [];
    if (candles.length < 30) return null;

    const closes = candles.map(function(c) { return Number(c[4]); });
    const highs = candles.map(function(c) { return Number(c[2]); });
    const lows = candles.map(function(c) { return Number(c[3]); });
    const volumes = candles.map(function(c) { return Number(c[5]); });

    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const rsiValue = rsi(closes, 14);
    const price = closes[closes.length - 1];
    if (!Number.isFinite(price) || !Number.isFinite(rsiValue)) return null;

    const trendUp = ema9 > ema21;
    const trendDown = ema9 < ema21;
    const recentHigh = Math.max.apply(null, highs.slice(-12));
    const recentLow = Math.min.apply(null, lows.slice(-12));
    const avgVol = volumes.slice(-21, -1).reduce(function(a, b) { return a + b; }, 0) / 20;
    const currentVol = volumes[volumes.length - 1];
    const volumeRatio = avgVol > 0 ? currentVol / avgVol : 1;

    let direction = "";
    let score = 0;

    if (trendUp && rsiValue >= 48 && rsiValue <= 70) {
      direction = "LONG";
      score += 40;
      if (rsiValue >= 52 && rsiValue <= 65) score += 15;
    } else if (trendDown && rsiValue >= 30 && rsiValue <= 52) {
      direction = "SHORT";
      score += 40;
      if (rsiValue >= 35 && rsiValue <= 48) score += 15;
    } else {
      return null;
    }

    if (volumeRatio >= 1.2) score += 20;
    if (volumeRatio >= 1.5) score += 10;

    const change24h = pct24h(ticker);
    if (Number.isFinite(change24h)) {
      if ((direction === "LONG" && change24h > 0) ||
          (direction === "SHORT" && change24h < 0)) score += 10;
    }

    // Entry is a practical area around the current market price.
    const entryLow = price * 0.999;
    const entryHigh = price * 1.001;
    const entryMid = (entryLow + entryHigh) / 2;

    // Structural SL is retained from the existing scanner logic.
    let sl;
    if (direction === "LONG") {
      sl = recentLow < price ? recentLow : price * 0.995;
      if (!(sl > 0 && sl < entryMid)) return null;
    } else {
      sl = recentHigh > price ? recentHigh : price * 1.005;
      if (!(sl > entryMid)) return null;
    }

    // 10X leverage: targets are opportunity-based, not fixed.
    // Allowed displayed P&L bands:
    // TP1 = 15–20%, TP2 = 30–35%, TP3 = 60–65%.
    // Stronger setups/volatility move toward the upper end of each band.
    const scoreOpportunity = Math.max(0, Math.min(1, (score - 40) / 55));
    const volatilityOpportunity = Number.isFinite(change24h)
      ? Math.max(0, Math.min(1, Math.abs(change24h) / 10))
      : 0;
    const opportunity = (scoreOpportunity * 0.70) + (volatilityOpportunity * 0.30);

    const targetPcts = [
      Number((15 + (5 * opportunity)).toFixed(1)),
      Number((30 + (5 * opportunity)).toFixed(1)),
      Number((60 + (5 * opportunity)).toFixed(1))
    ];
    const targetMoves = targetPcts.map(function(p) { return p / 10 / 100; });

    let tp1, tp2, tp3;
    if (direction === "LONG") {
      tp1 = entryMid * (1 + targetMoves[0]);
      tp2 = entryMid * (1 + targetMoves[1]);
      tp3 = entryMid * (1 + targetMoves[2]);
    } else {
      tp1 = entryMid * (1 - targetMoves[0]);
      tp2 = entryMid * (1 - targetMoves[1]);
      tp3 = entryMid * (1 - targetMoves[2]);
    }

    const tradeSetup = detectTradeSetup(closes, highs, lows, direction);
    const rawCoin = symbol.replace("-USDT-SWAP", "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

    return {
      symbol: symbol,
      pair: rawCoin + "/USDT",
      coinTag: rawCoin + "USDT",
      direction: direction,
      entry: fmt(entryLow) + " – " + fmt(entryHigh),
      entryLow: entryLow,
      entryHigh: entryHigh,
      entryMid: entryMid,
      sl: fmt(sl),
      slPrice: sl,
      tp1: fmt(tp1),
      tp2: fmt(tp2),
      tp3: fmt(tp3),
      tp1Price: tp1,
      tp2Price: tp2,
      tp3Price: tp3,
      tp1Pct: targetPcts[0],
      tp2Pct: targetPcts[1],
      tp3Pct: targetPcts[2],
      rsi: fmt(rsiValue),
      emaTrend: direction === "LONG" ? "Bullish" : "Bearish",
      change24h: Number.isFinite(change24h) ? fmt(change24h) : "n/a",
      volume: fmt(volumeRatio) + "x avg",
      tradeSetup: tradeSetup,
      timeframe: "15M",
      score: score
    };
  } catch (error) {
    return null;
  }
}

function detectTradeSetup(closes, highs, lows, direction) {
  const n = closes.length;
  const last = closes[n - 1];
  const prev = closes[n - 2];
  const high20 = Math.max.apply(null, highs.slice(-20, -1));
  const low20 = Math.min.apply(null, lows.slice(-20, -1));
  const range = Math.max.apply(null, highs.slice(-8)) - Math.min.apply(null, lows.slice(-8));
  const recent = closes.slice(-6);
  const rising = recent[recent.length - 1] > recent[0];
  const falling = recent[recent.length - 1] < recent[0];

  if (direction === "LONG" && last > high20 && prev <= high20) return "Bullish Breakout";
  if (direction === "SHORT" && last < low20 && prev >= low20) return "Bearish Breakdown";

  const lows6 = lows.slice(-12);
  const highs6 = highs.slice(-12);
  const firstLow = Math.min.apply(null, lows6.slice(0, 6));
  const secondLow = Math.min.apply(null, lows6.slice(6));
  const firstHigh = Math.max.apply(null, highs6.slice(0, 6));
  const secondHigh = Math.max.apply(null, highs6.slice(6));

  if (direction === "LONG" && Math.abs(firstLow - secondLow) / Math.max(firstLow, 1) < 0.008) return "Double Bottom";
  if (direction === "SHORT" && Math.abs(firstHigh - secondHigh) / Math.max(firstHigh, 1) < 0.008) return "Double Top";
  if (direction === "LONG" && rising && range > 0) return "Bullish Flag";
  if (direction === "SHORT" && falling && range > 0) return "Bearish Flag";
  if (direction === "LONG") return "Support Bounce";
  return "Resistance Rejection";
}

function ema(values, period) {
  if (!values.length) return NaN;

  const multiplier = 2 / (period + 1);
  let value = values[0];

  for (let i = 1; i < values.length; i++) {
    value = ((values[i] - value) * multiplier) + value;
  }

  return value;
}

function rsi(values, period) {
  if (values.length <= period) return NaN;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];

    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/* ============================================================
   FOLLOW-UPS
============================================================ */

async function runFollowups(env) {
  if (!isEnabled(env, "FOLLOWUPS_ENABLED", true)) return;
  if (!env.DB) return;

  const result = await env.DB.prepare(`
    SELECT *
    FROM users
    WHERE followup_status = 'active'
      AND lead_status IN ('new', 'interested', 'qualifying', 'qualified_questions')
    ORDER BY last_interaction ASC
    LIMIT 100
  `).all();

  const users = result && result.results ? result.results : [];

  for (const user of users) {
    const lastTime = Date.parse(
      user.last_interaction ||
      user.created_at ||
      ""
    );

    if (!Number.isFinite(lastTime)) continue;

    const ageDays = Math.floor(
      (Date.now() - lastTime) / 86400000
    );

    if (DEFAULTS.FOLLOWUP_DAYS.indexOf(ageDays) < 0) continue;
    if (Number(user.last_followup_day || 0) >= ageDays) continue;

    const message = followupMessage(user, ageDays);
    if (!message) continue;

    await sendTelegram(
      env,
      String(user.telegram_id),
      message,
      {
        inline_keyboard: [
          [{
            text: "💬 Continue Conversation",
            url: "https://t.me/" +
              stripAt(getEnv(env, "BOT_USERNAME", DEFAULTS.BOT_USERNAME))
          }],
          [{
            text: "🔕 Stop Messages",
            callback_data: "not_interested"
          }]
        ]
      }
    );

    await updateUser(env, String(user.telegram_id), {
      last_followup_day: ageDays
    });
  }
}

function followupMessage(user, days) {
  const lang = user.language || "English";
  const interest = user.interest || "your selected trading option";

  if (lang === "Hindi") {
    if (days === 1) return "नमस्ते 👋 आपने *" + interest + "* में रुचि दिखाई थी। अगर आप अभी भी interested हैं, तो यहीं से आगे बढ़ सकते हैं।";
    if (days === 2) return "बस एक छोटा follow-up 👋 क्या आप *" + interest + "* के बारे में आगे जानकारी चाहते हैं?";
    if (days === 3) return "अगर आपके मन में कोई सवाल है, यहाँ पूछ सकते हैं। मैं आपको सही टीम तक पहुँचाने में मदद कर दूँगा।";
    if (days === 5) return "आपकी *" + interest + "* वाली request अभी भी open है। अगर चाहें तो आगे continue कर सकते हैं।";
    if (days === 7) return "यह मेरा आखिरी follow-up है फिलहाल। जब भी आगे बढ़ना चाहें, बस मुझे message कर दें।";
  }

  if (lang === "Hinglish") {
    if (days === 1) return "Hi 👋 Aapne *" + interest + "* me interest dikhaya tha. Agar abhi bhi interested ho, hum wahi se continue kar sakte hain.";
    if (days === 2) return "Quick follow-up 👋 Kya aap *" + interest + "* ke baare me aage information chahte ho?";
    if (days === 3) return "Koi question hai to yahin puch sakte ho. Main aapko right team tak connect karwa dunga.";
    if (days === 5) return "Aapki *" + interest + "* wali request abhi bhi open hai. Jab ready ho, continue kar sakte ho.";
    if (days === 7) return "Filhaal ye mera last follow-up hai. Baad me continue karna ho to bas message kar dena.";
  }

  if (days === 1) return "Hi 👋 You had shown interest in *" + interest + "*. If you're still interested, we can continue from where we left off.";
  if (days === 2) return "Quick follow-up 👋 Would you like more information about *" + interest + "*?";
  if (days === 3) return "If you have any question, just reply here. I can help connect you with the right team.";
  if (days === 5) return "Your *" + interest + "* request is still open. If you're ready, we can continue.";
  if (days === 7) return "This will be my last follow-up for now. Whenever you want to continue, just message me.";
  return "";
}

/* ============================================================
   PUBLIC CHANNEL
============================================================ */

async function sendPublicChannel(env, text) {
  const channel = getEnv(
    env,
    "CHANNEL_CHAT_ID",
    DEFAULTS.CHANNEL_CHAT_ID
  );

  if (!channel) return false;
  return await sendTelegram(env, channel, text);
}

/* ============================================================
   WEBHOOK
============================================================ */

async function setWebhook(env) {
  const workerUrl = getEnv(env, "WORKER_PUBLIC_URL", "");
  if (!workerUrl) {
    return {
      ok: false,
      error: "Set WORKER_PUBLIC_URL, e.g. https://multiquant-bot.futuremax09.workers.dev"
    };
  }

  const webhookUrl = workerUrl.replace(/\/+$/, "") + "/webhook";
  const body = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query", "chat_member"],
    drop_pending_updates: false
  };

  if (env.TELEGRAM_WEBHOOK_SECRET) {
    body.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
  }

  const response = await fetch(
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/setWebhook",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  return await response.json();
}

/* ============================================================
   ADMIN
============================================================ */

function isAdmin(userId, env) {
  return !!env.ADMIN_CHAT_ID &&
    String(env.ADMIN_CHAT_ID) === String(userId);
}

function isAdminCommand(text) {
  const commands = [
    "/status",
    "/positions",
    "/pnl",
    "/openpositions",
    "/weekly",
    "/monthly",
    "/news_on",
    "/news_off",
    "/signals_on",
    "/signals_off",
    "/econ_on",
    "/econ_off"
  ];

  return commands.indexOf(String(text || "").toLowerCase()) >= 0;
}


async function sendTelegramChunked(env, chatId, text, replyMarkup) {
  const MAX = 3800;
  const source = String(text || "");
  if (source.length <= MAX) return await sendTelegram(env, chatId, source, replyMarkup);

  const lines = source.split("\n");
  let chunk = "";
  let ok = true;
  for (const line of lines) {
    const candidate = chunk ? chunk + "\n" + line : line;
    if (candidate.length > MAX && chunk) {
      ok = (await sendTelegram(env, chatId, chunk)) && ok;
      chunk = line;
    } else if (line.length > MAX) {
      for (let i = 0; i < line.length; i += MAX) {
        const part = line.slice(i, i + MAX);
        if (i + MAX < line.length) ok = (await sendTelegram(env, chatId, part)) && ok;
        else chunk = part;
      }
    } else {
      chunk = candidate;
    }
  }
  if (chunk) ok = (await sendTelegram(env, chatId, chunk, replyMarkup)) && ok;
  return ok;
}

function reportMovePct(direction, entry, price) {
  const e = Number(entry), p = Number(price);
  if (!(e > 0) || !(p > 0)) return null;
  return (direction === "LONG" ? (p - e) / e : (e - p) / e) * 1000;
}

function reportFmt(value) {
  const n = Number(value);
  if (!(n > 0)) return "N/A";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(6);
  return n.toFixed(8);
}

function reportDateTime(value) {
  if (!value) return { date: "N/A", time: "N/A" };
  const raw = String(value).endsWith("Z") ? String(value) : String(value).replace(" ", "T") + "Z";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { date: String(value), time: "N/A" };
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${parts.day}-${parts.month}-${parts.year}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

async function handlePositionsCommand(chatId, env) {
  if (!env.DB) return await sendTelegram(env, chatId, "❌ D1 database is not available.");
  try {
    await ensureSchema(env);
    const result = await env.DB.prepare(`SELECT * FROM signal_positions WHERE status='OPEN' ORDER BY id ASC LIMIT 50`).all();
    const positions = result?.results || [];
    if (!positions.length) return await sendTelegram(env, chatId, "📊 LIVE OPEN POSITIONS\n\nNo open positions.");

    let tickers = null;
    try { tickers = await getOkxTickers(env); } catch (error) { console.error("POSITIONS TICKER SNAPSHOT ERROR", error); }
    const tickerMap = new Map((tickers || []).filter(x => x?.instId && Number(x.last) > 0).map(x => [x.instId, Number(x.last)]));

    const rows = positions.map((pos, i) => {
      const current = tickerMap.get(pos.symbol);
      const move = reportMovePct(pos.direction, pos.entry_mid, current);
      const opened = reportDateTime(pos.created_at);
      const peak = pos.direction === "LONG" ? pos.highest_price : pos.lowest_price;
      const peakMove = reportMovePct(pos.direction, pos.entry_mid, peak);
      return {
        index: i + 1,
        move,
        block: [
          `${i + 1}. ${String(pos.pair || pos.symbol).replace(/[_*`]/g, "")} — ${pos.direction}`,
          `📅 Open Date: ${opened.date}`,
          `⏰ Open Time: ${opened.time}`,
          `💰 Open Price: ${reportFmt(pos.entry_mid)}`,
          `📍 Current Price: ${reportFmt(current)}`,
          `📈 Current P/L: ${move === null ? "N/A" : (move >= 0 ? "+" : "") + move.toFixed(2) + "%"}`,
          `🎯 TP1: ${reportFmt(pos.tp1_price)}`,
          `🎯 TP2: ${reportFmt(pos.tp2_price)}`,
          `🎯 TP3: ${reportFmt(pos.tp3_price)}`,
          `🛑 SL: ${reportFmt(pos.sl_price)}`,
          `TP1 ${Number(pos.tp1_hit) ? "✅" : "❌"}    TP2 ${Number(pos.tp2_hit) ? "✅" : "❌"}    TP3 ${Number(pos.tp3_hit) ? "✅" : "❌"}`,
          `🏆 Best Move: ${peakMove === null ? "N/A" : (peakMove >= 0 ? "+" : "") + peakMove.toFixed(2) + "%"}`
        ].join("\n")
      };
    });

    const profitable = rows.filter(x => x.move !== null && x.move > 0).length;
    const losing = rows.filter(x => x.move !== null && x.move < 0).length;
    const flat = rows.filter(x => x.move !== null && x.move === 0).length;
    const currentNet = rows.reduce((sum, x) => sum + (x.move === null ? 0 : x.move), 0);
    const best = rows.filter(x => x.move !== null).sort((a,b) => b.move - a.move)[0];
    const worst = rows.filter(x => x.move !== null).sort((a,b) => a.move - b.move)[0];
    const tp1 = positions.filter(x => Number(x.tp1_hit)).length;
    const tp2 = positions.filter(x => Number(x.tp2_hit)).length;
    const tp3 = positions.filter(x => Number(x.tp3_hit)).length;

    const summary = [
      "📊 LIVE OPEN POSITIONS",
      "",
      `Open Positions: ${positions.length}`,
      `🟢 Profitable: ${profitable}`,
      `🔴 Losing: ${losing}`,
      `⚪ Flat: ${flat}`,
      `📈 Current Net P/L: ${currentNet >= 0 ? "+" : ""}${currentNet.toFixed(2)}%`,
      `🎯 TP1 Hits: ${tp1}   TP2 Hits: ${tp2}   TP3 Hits: ${tp3}`,
      best ? `🏆 Best Current: #${best.index} ${best.move >= 0 ? "+" : ""}${best.move.toFixed(2)}%` : "🏆 Best Current: N/A",
      worst ? `📉 Worst Current: #${worst.index} ${worst.move >= 0 ? "+" : ""}${worst.move.toFixed(2)}%` : "📉 Worst Current: N/A"
    ].join("\n");

    // Keep every position intact. Never split a signal block across Telegram messages.
    const MAX = 3800;
    const pages = [];
    let page = "";
    for (const row of rows) {
      const candidate = page ? page + "\n\n" + row.block : row.block;
      if (candidate.length > MAX && page) {
        pages.push(page);
        page = row.block;
      } else {
        page = candidate;
      }
    }
    if (page) pages.push(page);

    for (let i = 0; i < pages.length; i++) {
      const header = i === 0
        ? summary + `\n\n━━━━━━━━━━━━━━━━━━\n📋 SIGNALS — PAGE ${i + 1}/${pages.length}`
        : `📊 LIVE OPEN POSITIONS\n\n📋 SIGNALS — PAGE ${i + 1}/${pages.length}`;
      await sendTelegram(env, chatId, header + "\n\n" + pages[i]);
    }
    await sendTelegram(env, chatId, "\n⚠️ P/L is signal price-move × 10 convention, not broker/account P&L.");
  } catch (error) {
    console.error("POSITIONS COMMAND ERROR", error);
    await sendTelegram(env, chatId, "❌ /positions error. Check Worker logs.");
  }
}

async function handleTradeReportCommand(chatId, env, period) {
  if (!env.DB) return await sendTelegram(env, chatId, "❌ D1 database is not available.");
  try {
    await ensureSchema(env);
    const where = period === "weekly"
      ? "closed_at >= datetime('now','-7 days')"
      : "closed_at >= datetime('now','+5 hours 30 minutes','start of month','-5 hours 30 minutes')";
    const label = period === "weekly" ? "LAST 7 DAYS" : "CURRENT MONTH";
    const result = await env.DB.prepare(`SELECT * FROM signal_positions WHERE status='CLOSED' AND closed_at IS NOT NULL AND ${where} ORDER BY closed_at ASC`).all();
    const closed = result?.results || [];
    const openResult = await env.DB.prepare("SELECT COUNT(*) AS c FROM signal_positions WHERE status='OPEN'").first();
    const openCount = Number(openResult?.c || 0);
    const total = closed.length;
    const reportProfitFor = (x) => {
      const stored = Number(x.realized_profit_pct || 0);
      const peak = Number(x.highest_profit_pct || 0);
      return String(x.close_reason || "").toLowerCase() === "direct sl" ? stored : Math.max(stored, peak);
    };
    const wins = closed.filter(x => reportProfitFor(x) > 0).length;
    const losses = closed.filter(x => reportProfitFor(x) < 0).length;
    const grossProfit = closed.reduce((a,x) => a + Math.max(0, reportProfitFor(x)), 0);
    const grossLoss = closed.reduce((a,x) => a + Math.min(0, reportProfitFor(x)), 0);
    const net = grossProfit + grossLoss;
    const winRate = total ? wins / total * 100 : 0;
    const tp1 = closed.filter(x => Number(x.tp1_hit)).length;
    const tp2 = closed.filter(x => Number(x.tp2_hit)).length;
    const tp3 = closed.filter(x => Number(x.tp3_hit)).length;
    const directSl = closed.filter(x => String(x.close_reason) === "Direct SL").length;
    const trailing = closed.filter(x => String(x.close_reason) === "Trailing/Reversal").length;
    const sorted = closed.slice().sort((a,b) => reportProfitFor(b)-reportProfitFor(a));
    const best = sorted[0], worst = sorted[sorted.length - 1];

    const lines = [
      `📊 ${label} TRADE REPORT`, "",
      period === "weekly" ? "Period: Last 7 days" : "Period: Current calendar month",
      `Total Closed: ${total}`,
      `Open Positions: ${openCount}`,
      `Profitable: ${wins} | Losing: ${losses}`,
      `Win Rate: ${winRate.toFixed(1)}%`, "",
      `💰 Gross Profit: +${grossProfit.toFixed(2)}%`,
      `📉 Gross Loss: ${grossLoss.toFixed(2)}%`,
      `📊 Net P/L: ${net >= 0 ? "+" : ""}${net.toFixed(2)}%`, "",
      `🎯 TP1 Hits: ${tp1}`,
      `🎯 TP2 Hits: ${tp2}`,
      `🎯 TP3 Hits: ${tp3}`,
      `😔 Direct SL: ${directSl}`,
      `🔒 Trailing/Reversal: ${trailing}`
    ];
    if (best) { const bp = reportProfitFor(best); lines.push("", `🏆 Best: ${best.pair} ${best.direction} ${bp>=0?"+":""}${bp.toFixed(2)}%`); }
    if (worst) { const wp = reportProfitFor(worst); lines.push(`📉 Worst: ${worst.pair} ${worst.direction} ${wp>=0?"+":""}${wp.toFixed(2)}%`); }

    if (closed.length) {
      lines.push("", "━━━━━━━━━━━━━━━━━━", "CLOSED TRADE DETAILS");
      closed.forEach((x,i) => {
        const o = reportDateTime(x.created_at), c = reportDateTime(x.closed_at);
        const rpStored = Number(x.realized_profit_pct || 0), hp = Number(x.highest_profit_pct || 0);
        const rp = String(x.close_reason || "").toLowerCase() === "direct sl" ? rpStored : Math.max(rpStored, hp);
        lines.push(
          "", `${i+1}. ${String(x.pair || x.symbol)} — ${x.direction}`,
          `Open: ${o.date} ${o.time} | ${reportFmt(x.entry_mid)}`,
          `SL: ${reportFmt(x.sl_price)} | TP1: ${reportFmt(x.tp1_price)} | TP2: ${reportFmt(x.tp2_price)} | TP3: ${reportFmt(x.tp3_price)}`,
          `TP: ${Number(x.tp1_hit)?"✅":"❌"} ${Number(x.tp2_hit)?"✅":"❌"} ${Number(x.tp3_hit)?"✅":"❌"}`,
          `Best Move: +${hp.toFixed(2)}%`,
          `Close: ${c.date} ${c.time} | ${reportFmt(x.close_price)}`,
          `Realized P/L: ${rp>=0?"+":""}${rp.toFixed(2)}%`,
          `Reason: ${x.close_reason || "Unknown"}`
        );
      });
    } else {
      lines.push("", "No closed trades in this period.");
    }
    await sendTelegramChunked(env, chatId, lines.join("\n"));
  } catch (error) {
    console.error("TRADE REPORT ERROR", period, error);
    await sendTelegram(env, chatId, `❌ /${period} report error. Check Worker logs.`);
  }
}

async function handleAdminCommand(chatId, text, env) {
  const command = String(text || "").toLowerCase();

  if (command === "/positions" || command === "/pnl" || command === "/openpositions") {
    await handlePositionsCommand(chatId, env);
    return;
  }

  if (command === "/weekly" || command === "/monthly") {
    await handleTradeReportCommand(chatId, env, command.slice(1));
    return;
  }

  if (command === "/status") {
    await sendTelegram(
      env,
      chatId,
      "⚙️ *BOT STATUS*\n\n" +
      "Telegram: " + (env.TELEGRAM_BOT_TOKEN ? "✅" : "❌") + "\n" +
      "Gemini: " + (env.GEMINI_API_KEY ? "✅" : "❌") + "\n" +
      "D1: " + (env.DB ? "✅" : "❌") + "\n" +
      "Model: " +
        getEnv(env, "GEMINI_MODEL", DEFAULTS.GEMINI_MODEL) + "\n" +
      "News feeds: " + getNewsFeeds(env).length + "\n" +
      "Economic API: " + (env.ECONOMIC_API_URL ? "configured" : "not configured") + "\n" +
      "Team alerts: " +
        (env.TEAM_ALERT_CHAT_ID || env.ADMIN_CHAT_ID ? "configured" : "not configured")
    );
    return;
  }

  await sendTelegram(
    env,
    chatId,
    "Command received. Module state is controlled by Cloudflare environment variables."
  );
}

/* ============================================================
   D1
============================================================ */

async function ensureSchema(env) {
  if (!env.DB) return;
  if (schemaReady) return;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    if (!env.DB) return;

    const statements = [
      `CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        first_name TEXT,
        username TEXT,
        language TEXT,
        interest TEXT,
        capital TEXT,
        trading_type TEXT,
        experience TEXT,
        market TEXT,
        requirement TEXT,
        lead_status TEXT DEFAULT 'new',
        followup_status TEXT DEFAULT 'active',
        last_followup_day INTEGER DEFAULT 0,
        joined_community INTEGER DEFAULT 0,
        team_referred TEXT,
        created_at TEXT,
        last_interaction TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,

      `CREATE INDEX IF NOT EXISTS idx_users_interest
        ON users(interest)`,

      `CREATE INDEX IF NOT EXISTS idx_messages_user
        ON messages(telegram_id)`,

      `CREATE INDEX IF NOT EXISTS idx_users_status
        ON users(lead_status)`,

      `CREATE TABLE IF NOT EXISTS bot_meta (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS signal_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        pair TEXT NOT NULL,
        direction TEXT NOT NULL,
        channel_message_id INTEGER,
        sent_at TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS signal_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        pair TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_mid REAL NOT NULL,
        sl_price REAL NOT NULL,
        tp1_price REAL NOT NULL,
        tp2_price REAL NOT NULL,
        tp3_price REAL NOT NULL,
        tp1_hit INTEGER DEFAULT 0,
        tp2_hit INTEGER DEFAULT 0,
        tp3_hit INTEGER DEFAULT 0,
        highest_price REAL,
        lowest_price REAL,
        status TEXT DEFAULT 'OPEN',
        channel_message_id INTEGER,
        created_at TEXT,
        updated_at TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS signal_event_guard (
        event_key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    for (const sql of statements) {
      try {
        await env.DB.prepare(sql).run();
      } catch (error) {
        console.error("D1 SCHEMA ERROR", error && error.message ? error.message : error);
      }
    }

    // Backward-compatible columns. Check table metadata first so normal
    // deployments do not spam D1 logs with duplicate-column errors.
    async function addColumnIfMissing(table, column, definition) {
      try {
        const info = await env.DB.prepare("PRAGMA table_info(" + table + ")").all();
        const exists = (info.results || []).some(row => String(row.name) === column);
        if (!exists) await env.DB.prepare("ALTER TABLE " + table + " ADD COLUMN " + definition).run();
      } catch (error) {
        console.error("D1 MIGRATION ERROR", table, column, error && error.message ? error.message : error);
      }
    }

    await addColumnIfMissing("users", "requirement", "requirement TEXT");
    await addColumnIfMissing("users", "last_followup_day", "last_followup_day INTEGER DEFAULT 0");

    // Permanent closed-trade history lives on the same signal_positions row.
    // This keeps weekly/monthly reports reconstructable after the position closes.
    await addColumnIfMissing("signal_positions", "closed_at", "closed_at TEXT");
    await addColumnIfMissing("signal_positions", "close_price", "close_price REAL");
    await addColumnIfMissing("signal_positions", "realized_profit_pct", "realized_profit_pct REAL");
    await addColumnIfMissing("signal_positions", "highest_profit_pct", "highest_profit_pct REAL");
    await addColumnIfMissing("signal_positions", "close_reason", "close_reason TEXT");
    try {
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_signal_positions_status_created ON signal_positions(status, created_at)").run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_signal_positions_closed_at ON signal_positions(closed_at)").run();
    } catch (error) {
      console.error("D1 SIGNAL INDEX ERROR", error && error.message ? error.message : error);
    }
  })();

  try {
    await schemaPromise;
    schemaReady = true;
  } finally {
    schemaPromise = null;
  }
}

async function ensureUser(env, telegramId, firstName, username) {
  if (!env.DB) return;

  await ensureSchema(env);

  await env.DB.prepare(`
    INSERT INTO users (
      telegram_id,
      first_name,
      username,
      language,
      lead_status,
      followup_status,
      created_at,
      last_interaction
    )
    VALUES (?, ?, ?, 'English', 'new', 'active', datetime('now'), datetime('now'))
    ON CONFLICT(telegram_id)
    DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username,
      last_interaction = datetime('now')
  `).bind(
    telegramId,
    firstName || "Friend",
    username || ""
  ).run();
}

async function getUser(env, telegramId) {
  if (!env.DB) return {};

  await ensureSchema(env);

  const row = await env.DB.prepare(
    "SELECT * FROM users WHERE telegram_id = ? LIMIT 1"
  ).bind(telegramId).first();

  return row || {};
}

async function updateUser(env, telegramId, fields) {
  if (!env.DB) return;

  await ensureSchema(env);

  const allowed = [
    "first_name",
    "username",
    "language",
    "interest",
    "capital",
    "trading_type",
    "experience",
    "market",
    "requirement",
    "lead_status",
    "followup_status",
    "last_followup_day",
    "joined_community",
    "team_referred",
    "last_interaction"
  ];

  const keys = Object.keys(fields).filter(function(key) {
    return allowed.indexOf(key) >= 0;
  });

  if (!keys.length) return;

  const setClause = keys.map(function(key) {
    return key + " = ?";
  }).join(", ");

  const values = keys.map(function(key) {
    return fields[key];
  });

  await env.DB.prepare(
    "UPDATE users SET " + setClause + " WHERE telegram_id = ?"
  ).bind(
    ...values,
    telegramId
  ).run();
}

async function saveMessage(env, telegramId, role, content) {
  if (!env.DB) return;

  await ensureSchema(env);

  await env.DB.prepare(`
    INSERT INTO messages (
      telegram_id,
      role,
      content,
      created_at
    )
    VALUES (?, ?, ?, datetime('now'))
  `).bind(
    telegramId,
    role,
    content
  ).run();

  // Keep only recent history to control D1 size.
  try {
    await env.DB.prepare(`
      DELETE FROM messages
      WHERE telegram_id = ?
        AND id NOT IN (
          SELECT id
          FROM messages
          WHERE telegram_id = ?
          ORDER BY id DESC
          LIMIT ?
        )
    `).bind(
      telegramId,
      telegramId,
      DEFAULTS.MAX_HISTORY
    ).run();
  } catch (error) {
    console.error("MESSAGE TRIM ERROR", error);
  }
}

async function hasMeta(env, key) {
  if (!env.DB) return false;

  await ensureSchema(env);

  const row = await env.DB.prepare(
    "SELECT key FROM bot_meta WHERE key = ? LIMIT 1"
  ).bind(key).first();

  return !!row;
}

async function getMeta(env, key) {
  if (!env.DB) return null;
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT value FROM bot_meta WHERE key = ? LIMIT 1").bind(key).first();
  return row ? row.value : null;
}

async function setMeta(env, key, value) {
  if (!env.DB) return;

  await ensureSchema(env);

  await env.DB.prepare(`
    INSERT OR REPLACE INTO bot_meta (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
  `).bind(
    key,
    value
  ).run();
}

/* ============================================================
   SCHEDULED JOBS
============================================================ */

async function syncOkxMonitorDurableObject(env) {
  if (!env.OKX_MONITOR || !env.DB) return;
  try {
    const id = env.OKX_MONITOR.idFromName("multiquant-open-positions");
    const stub = env.OKX_MONITOR.get(id);
    await stub.fetch("https://okx-monitor/sync", { method: "POST" });
  } catch (error) {
    console.error("OKX MONITOR DO SYNC ERROR", error);
  }
}

function isSignalScanDue() {
  const minutes = new Date().getMinutes();
  const interval = Number(DEFAULTS.SIGNAL_SCAN_INTERVAL_MINUTES) || 15;
  // Cloudflare Cron can fire a few seconds into the scheduled minute.
  // The Worker currently runs every 5 minutes, so accept the first 5-minute
  // window of each signal interval instead of requiring an exact minute.
  return (minutes % interval) < 5;
}

async function runScheduledJobs(env) {
  console.log("SCHEDULED RUN", new Date().toISOString());

  await ensureSchema(env);

  try { await runFollowups(env); } catch (error) { console.error("FOLLOWUP JOB ERROR", error); }
  try { await runNewsJob(env); } catch (error) { console.error("NEWS JOB ERROR", error); }
  try { await runEconomicJob(env); } catch (error) { console.error("ECONOMIC JOB ERROR", error); }

  // The Durable Object syncs itself from its 5-minute alarm.
  // Do not call the DO from every Worker cron tick; that creates an unnecessary
  // DO request and can produce sync errors even though the DO alarm is healthy.

  // Signal discovery runs every 15 minutes, never more than one signal per scan,
  // and the separate D1 history enforces the 30/24h + 45-minute gap quota.
  const signalDue = isSignalScanDue();
  console.log("SIGNAL SCAN CHECK", JSON.stringify({
    due: signalDue,
    utcMinute: new Date().getUTCMinutes(),
    interval: Number(DEFAULTS.SIGNAL_SCAN_INTERVAL_MINUTES) || 15
  }));

  if (signalDue) {
    let okxTickers = null;
    try {
      if (isEnabled(env, "SIGNALS_ENABLED", true)) okxTickers = await getOkxTickers(env);
    } catch (error) {
      console.error("OKX TICKER SNAPSHOT ERROR", error);
    }

    console.log("OKX TICKER SNAPSHOT", JSON.stringify({ count: Array.isArray(okxTickers) ? okxTickers.length : 0 }));
    try { await runSignalJob(env, okxTickers); } catch (error) { console.error("SIGNAL JOB ERROR", error); }
  }
}

/* ============================================================
   OKX WEBSOCKET DURABLE OBJECT MONITOR
============================================================ */

export class OkxMonitorDO extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.positions = new Map();
    this.subscribed = new Set();
    this.ws = null;
    this.wsConnecting = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.heartbeatTimer = null;
    this.lastWsMessageAt = Date.now();
    this.lastSyncAt = 0;
    this.tickerCache = new Map();
    this.tickersSubscribed = false;
    this.tickerWs = null;
    this.tickerWsConnecting = false;
    this.tickerReconnectTimer = null;
    this.tickerReconnectAttempts = 0;
    this.tickerHeartbeatTimer = null;
    this.lastTickerWsMessageAt = Date.now();
    this.tickerInstrumentIds = null;
    this.tickerInstrumentFetchedAt = 0;
    this.connectWebSocket();
    // Ticker snapshots are collected by getOkxTickers() in the Worker.
    // Keeping a high-volume ticker stream inside this Durable Object would
    // consume the Workers Free Durable Object request allowance.
    this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/sync") {
      await this.syncPositions();
      return new Response("OK");
    }
    if (url.pathname === "/tickers") {
      const tickers = Array.from(this.tickerCache.values());
      return new Response(JSON.stringify({
        tickers,
        count: tickers.length,
        updatedAt: Date.now()
      }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/status") {
      return new Response(JSON.stringify({
        websocket: !!this.ws && this.ws.readyState === WebSocket.OPEN,
        positions: this.positions.size,
        subscriptions: this.subscribed.size,
        tickers: this.tickerCache.size,
        lastSyncAt: this.lastSyncAt
      }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("OK");
  }

  async alarm() {
    try {
      await this.flushPositionsToD1();
      await this.syncPositions();
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) this.connectWebSocket();
    } catch (error) {
      console.error("OKX MONITOR ALARM ERROR", JSON.stringify({
        name: error && error.name,
        message: error && error.message,
        stack: error && error.stack
      }));
    } finally {
      await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
  }

  async connectWebSocket() {
    if (this.wsConnecting || (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))) return;

    this.wsConnecting = true;
    const url = getEnv(this.env, "OKX_WS_URL", "wss://ws.okx.com/ws/v5/business");

    try {
      console.log("OKX MONITOR WS CONNECT", url);
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.addEventListener("open", async () => {
        this.wsConnecting = false;
        this.reconnectAttempts = 0;
        this.lastWsMessageAt = Date.now();
        this.startHeartbeat();
        console.log("OKX MONITOR WS OPEN", url);
        try {
          await this.reconcileSubscriptions(true);
        } catch (error) {
          console.error("OKX MONITOR WS SUBSCRIBE ERROR", error);
        }
      });

      ws.addEventListener("message", async (event) => {
        this.lastWsMessageAt = Date.now();
        await this.handleWsMessage(event.data);
      });

      ws.addEventListener("close", (event) => {
        this.wsConnecting = false;
        this.stopHeartbeat();
        if (this.ws === ws) this.ws = null;
        this.subscribed.clear();
        this.tickersSubscribed = false;
        console.warn("OKX MONITOR WS CLOSE", JSON.stringify({code:event && event.code, reason:event && event.reason}));
        this.scheduleReconnect();
      });

      ws.addEventListener("error", (error) => {
        console.error("OKX MONITOR WS ERROR", {
          type: error && error.type,
          message: error && error.message,
          readyState: ws.readyState
        });
      });
    } catch (error) {
      this.wsConnecting = false;
      this.stopHeartbeat();
      console.error("OKX MONITOR WS CONNECT ERROR", error);
      this.scheduleReconnect();
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      try {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this.lastWsMessageAt >= 25000) {
          this.ws.send("ping");
          console.log("OKX MONITOR WS HEARTBEAT");
        }
      } catch (error) {
        console.error("OKX MONITOR WS HEARTBEAT ERROR", error);
      }
    }, 10000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const attempt = Math.min(this.reconnectAttempts || 0, 6);
    const base = Math.min(60000, 2000 * Math.pow(2, attempt));
    const jitter = Math.floor(Math.random() * 1000);
    const delay = base + jitter;
    this.reconnectAttempts = attempt + 1;
    console.log("OKX MONITOR WS RECONNECT SCHEDULED", JSON.stringify({attempt:this.reconnectAttempts, delayMs:delay}));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, delay);
  }

  async getTickerInstrumentIds() {
    const now = Date.now();
    if (Array.isArray(this.tickerInstrumentIds) && this.tickerInstrumentIds.length && (now - this.tickerInstrumentFetchedAt) < 6 * 60 * 60 * 1000) {
      return this.tickerInstrumentIds;
    }

    try {
      const response = await fetch(
        "https://www.okx.com/api/v5/public/instruments?instType=SWAP",
        { method: "GET", headers: { "Accept": "application/json" } }
      );
      if (!response.ok) {
        console.error("OKX TICKER INSTRUMENTS ERROR", response.status);
        return Array.isArray(this.tickerInstrumentIds) ? this.tickerInstrumentIds : [];
      }

      const payload = await response.json();
      const ids = Array.isArray(payload.data)
        ? payload.data
            .filter(item => item && item.instType === "SWAP" && typeof item.instId === "string" && item.instId.endsWith("-USDT-SWAP"))
            .map(item => item.instId)
        : [];

      if (!ids.length) {
        console.warn("OKX TICKER INSTRUMENTS EMPTY");
        return Array.isArray(this.tickerInstrumentIds) ? this.tickerInstrumentIds : [];
      }

      this.tickerInstrumentIds = Array.from(new Set(ids));
      this.tickerInstrumentFetchedAt = now;
      console.log("OKX TICKER INSTRUMENTS LOADED", JSON.stringify({ count: this.tickerInstrumentIds.length }));
      return this.tickerInstrumentIds;
    } catch (error) {
      console.error("OKX TICKER INSTRUMENTS FETCH ERROR", error);
      return Array.isArray(this.tickerInstrumentIds) ? this.tickerInstrumentIds : [];
    }
  }

  startTickerHeartbeat() {
    this.stopTickerHeartbeat();
    this.lastTickerWsMessageAt = Date.now();
    this.tickerHeartbeatTimer = setInterval(() => {
      try {
        if (!this.tickerWs || this.tickerWs.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this.lastTickerWsMessageAt >= 20000) {
          this.tickerWs.send("ping");
          console.log("OKX TICKER WS HEARTBEAT");
        }
      } catch (error) {
        console.error("OKX TICKER WS HEARTBEAT ERROR", error);
      }
    }, 10000);
  }

  stopTickerHeartbeat() {
    if (this.tickerHeartbeatTimer) {
      clearInterval(this.tickerHeartbeatTimer);
      this.tickerHeartbeatTimer = null;
    }
  }

  async connectTickerWebSocket() {
    if (this.tickerWsConnecting || (this.tickerWs && (this.tickerWs.readyState === WebSocket.OPEN || this.tickerWs.readyState === WebSocket.CONNECTING))) return;

    this.tickerWsConnecting = true;
    const url = getEnv(this.env, "OKX_PUBLIC_WS_URL", "wss://ws.okx.com/ws/v5/public");

    try {
      console.log("OKX TICKER WS CONNECT", url);
      const ws = new WebSocket(url);
      this.tickerWs = ws;

      ws.addEventListener("open", async () => {
        this.tickerWsConnecting = false;
        this.tickerReconnectAttempts = 0;
        this.tickersSubscribed = false;
        this.startTickerHeartbeat();

        const instrumentIds = await this.getTickerInstrumentIds();
        if (!instrumentIds.length || this.tickerWs !== ws || ws.readyState !== WebSocket.OPEN) {
          console.error("OKX TICKER WS NO_INSTRUMENTS");
          try { ws.close(); } catch (_) {}
          return;
        }

        // OKX's current tickers channel requires an instId. Subscribe to all
        // USDT perpetuals in bounded batches instead of using the rejected
        // { channel: "tickers", instType: "SWAP" } form.
        const batchSize = 100;
        let sent = 0;
        for (let i = 0; i < instrumentIds.length; i += batchSize) {
          const batch = instrumentIds.slice(i, i + batchSize).map(instId => ({ channel: "tickers", instId }));
          ws.send(JSON.stringify({ op: "subscribe", args: batch }));
          sent += batch.length;
        }
        this.tickersSubscribed = true;
        console.log("OKX TICKER WS OPEN");
        console.log("OKX TICKER WS TICKERS SUBSCRIBED", JSON.stringify({ count: sent, batchSize }));
      });

      ws.addEventListener("message", async (event) => {
        this.lastTickerWsMessageAt = Date.now();
        await this.handleTickerWsMessage(event.data);
      });

      ws.addEventListener("close", (event) => {
        this.tickerWsConnecting = false;
        this.stopTickerHeartbeat();
        if (this.tickerWs === ws) this.tickerWs = null;
        this.tickersSubscribed = false;
        console.warn("OKX TICKER WS CLOSE", JSON.stringify({code:event && event.code, reason:event && event.reason}));
        this.scheduleTickerReconnect();
      });

      ws.addEventListener("error", (error) => {
        console.error("OKX TICKER WS ERROR", {
          type: error && error.type,
          message: error && error.message,
          readyState: ws.readyState
        });
      });
    } catch (error) {
      this.tickerWsConnecting = false;
      this.stopTickerHeartbeat();
      console.error("OKX TICKER WS CONNECT ERROR", error);
      this.scheduleTickerReconnect();
    }
  }

  scheduleTickerReconnect() {
    if (this.tickerReconnectTimer) return;
    const attempt = Math.min(this.tickerReconnectAttempts || 0, 6);
    const base = Math.min(60000, 2000 * Math.pow(2, attempt));
    const jitter = Math.floor(Math.random() * 1000);
    const delay = base + jitter;
    this.tickerReconnectAttempts = attempt + 1;
    console.log("OKX TICKER WS RECONNECT SCHEDULED", JSON.stringify({attempt:this.tickerReconnectAttempts, delayMs:delay}));
    this.tickerReconnectTimer = setTimeout(() => {
      this.tickerReconnectTimer = null;
      this.connectTickerWebSocket();
    }, delay);
  }

  async handleTickerWsMessage(raw) {
    try {
      if (typeof raw === "string" && raw.toLowerCase() === "ping") {
        if (this.tickerWs && this.tickerWs.readyState === WebSocket.OPEN) this.tickerWs.send("pong");
        return;
      }
      const message = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!message) return;
      if (message.event === "error") {
        console.error("OKX TICKER WS EVENT ERROR", message);
        return;
      }
      if (message.arg && message.arg.channel === "tickers" && Array.isArray(message.data)) {
        for (const ticker of message.data) {
          if (ticker && ticker.instId) this.tickerCache.set(ticker.instId, ticker);
        }
        if (this.tickerCache.size && this.tickerCache.size % 100 === 0) {
          console.log("OKX TICKER WS SNAPSHOT", JSON.stringify({count:this.tickerCache.size}));
        }
      }
    } catch (error) {
      console.error("OKX TICKER WS MESSAGE ERROR", error);
    }
  }

  async reconcileSubscriptions(forceAll) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const desired = new Set(this.positions.keys());
    const toSubscribe = [];
    for (const symbol of desired) {
      if (forceAll || !this.subscribed.has(symbol)) toSubscribe.push({ channel: "candle5m", instId: symbol });
    }
    const toUnsubscribe = [];
    for (const symbol of Array.from(this.subscribed)) {
      if (!desired.has(symbol)) toUnsubscribe.push({ channel: "candle5m", instId: symbol });
    }
    if (toSubscribe.length) {
      this.ws.send(JSON.stringify({ op: "subscribe", args: toSubscribe }));
      for (const arg of toSubscribe) this.subscribed.add(arg.instId);
      console.log("OKX MONITOR WS SUBSCRIBED", toSubscribe.length);
    }
    if (toUnsubscribe.length) {
      this.ws.send(JSON.stringify({ op: "unsubscribe", args: toUnsubscribe }));
      for (const arg of toUnsubscribe) this.subscribed.delete(arg.instId);
    }
  }

  async syncPositions() {
    if (!this.env.DB) return;
    try {
      const result = await this.env.DB.prepare(`SELECT * FROM signal_positions WHERE status='OPEN' ORDER BY id ASC LIMIT 100`).all();
      const rows = result && result.results ? result.results : [];
      const next = new Map();
      for (const row of rows) {
        const existing = this.positions.get(row.symbol);
        next.set(row.symbol, {
          ...row,
          tp1_hit: Number(row.tp1_hit || 0) || (existing ? Number(existing.tp1_hit || 0) : 0),
          tp2_hit: Number(row.tp2_hit || 0) || (existing ? Number(existing.tp2_hit || 0) : 0),
          tp3_hit: Number(row.tp3_hit || 0) || (existing ? Number(existing.tp3_hit || 0) : 0),
          highest_price: existing ? Math.max(Number(row.highest_price || row.entry_mid), Number(existing.highest_price || row.entry_mid)) : Number(row.highest_price || row.entry_mid),
          lowest_price: existing ? Math.min(Number(row.lowest_price || row.entry_mid), Number(existing.lowest_price || row.entry_mid)) : Number(row.lowest_price || row.entry_mid)
        });
      }
      this.positions = next;
      this.lastSyncAt = Date.now();
      await this.reconcileSubscriptions(false);
    } catch (error) {
      console.error("OKX MONITOR POSITION SYNC ERROR", error);
    }
  }

  async handleWsMessage(raw) {
    try {
      if (typeof raw === "string" && raw.toLowerCase() === "ping") {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send("pong");
        return;
      }
      const message = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!message) return;
      if (message.event === "error") {
        console.error("OKX MONITOR WS EVENT ERROR", message);
        return;
      }
      if (!message.data || !message.arg || message.arg.channel !== "candle5m") return;
      const symbol = message.arg.instId;
      if (!symbol || !this.positions.has(symbol)) return;
      for (const candle of message.data) {
        if (Array.isArray(candle) && candle.length >= 5) await this.processCandle(symbol, candle);
      }
    } catch (error) {
      console.error("OKX MONITOR WS MESSAGE ERROR", error);
    }
  }

  async processCandle(symbol, candle) {
    const pos = this.positions.get(symbol);
    if (!pos || String(pos.status) !== "OPEN") return;
    const high = Number(candle[2]), low = Number(candle[3]);
    if (!(high > 0) || !(low > 0)) return;
    pos.highest_price = Math.max(Number(pos.highest_price || pos.entry_mid), high);
    pos.lowest_price = Math.min(Number(pos.lowest_price || pos.entry_mid), low);

    const newlyReached = [];
    const checks = [["TP1","tp1_hit",Number(pos.tp1_price)],["TP2","tp2_hit",Number(pos.tp2_price)],["TP3","tp3_hit",Number(pos.tp3_price)]];
    for (const [name, field, target] of checks) {
      if (Number(pos[field] || 0)) continue;
      const hit = pos.direction === "LONG" ? Number(pos.highest_price) >= target : Number(pos.lowest_price) <= target;
      if (!hit) continue;
      try {
        const r = await this.env.DB.prepare(`UPDATE signal_positions SET ${field}=1,highest_price=?,lowest_price=?,updated_at=datetime('now') WHERE id=? AND status='OPEN' AND ${field}=0`).bind(Number(pos.highest_price),Number(pos.lowest_price),Number(pos.id)).run();
        if (Number(r?.meta?.changes || 0) === 1) {
          pos[field]=1;
          newlyReached.push({name,price:target});
        }
      } catch (e) { console.error("OKX TP CLAIM ERROR", symbol, name, e); }
    }
    for (const hit of newlyReached) {
      const pct = Math.abs((Number(hit.price)-Number(pos.entry_mid))/Number(pos.entry_mid))*1000;
      const msg = "🎯 *"+hit.name+" HIT*\n\n📌 "+pos.pair+" — "+pos.direction+"\n💰 Price: `"+reportFmt(hit.price)+"`\n📈 Profit: *+"+pct.toFixed(1)+"%*"+(hit.name==="TP1"?"\n\n⚠️ SL is now protected at entry.":"");
      if (pos.channel_message_id) await sendTelegramReply(this.env,msg,pos.channel_message_id);
    }
    await this.persistPosition(pos);

    const anyTp = Number(pos.tp1_hit)||Number(pos.tp2_hit)||Number(pos.tp3_hit);
    let effectiveStop = Number(pos.sl_price);
    if (Number(pos.tp1_hit)) effectiveStop = Number(pos.entry_mid);
    if (Number(pos.tp3_hit)) {
      const entry=Number(pos.entry_mid);
      effectiveStop = pos.direction === "LONG" ? entry + Math.max(0,Number(pos.highest_price)-entry)*0.80 : entry - Math.max(0,entry-Number(pos.lowest_price))*0.80;
    }
    const stopHit = pos.direction === "LONG" ? low <= effectiveStop : high >= effectiveStop;
    if (!stopHit || newlyReached.some(x=>x.name==="TP3")) return;

    const closePrice = pos.direction === "LONG" ? (low <= effectiveStop ? effectiveStop : high) : (high >= effectiveStop ? effectiveStop : low);
    const realizedAtClose = reportMovePct(pos.direction,pos.entry_mid,closePrice);
    const peak = pos.direction === "LONG" ? Number(pos.highest_price) : Number(pos.lowest_price);
    const peakPct = Math.max(0,reportMovePct(pos.direction,pos.entry_mid,peak)||0);
    const reportProfit = anyTp ? peakPct : realizedAtClose;
    const reason = anyTp ? "Trailing/Reversal" : "Direct SL";
    const claim=await this.env.DB.prepare("UPDATE signal_positions SET status='CLOSING',updated_at=datetime('now') WHERE id=? AND status='OPEN'").bind(Number(pos.id)).run();
    if (Number(claim?.meta?.changes||0)!==1) return;
    pos.status="CLOSING"; this.positions.delete(symbol); await this.reconcileSubscriptions(false);
    const msg = anyTp
      ? "🔒 *SIGNAL CLOSED*\n\n📌 "+pos.pair+" — "+pos.direction+"\n\n💰 Closed Price: `"+reportFmt(closePrice)+"`\n📊 Profit: *+"+peakPct.toFixed(1)+"%*\n\n🏆 Highest Favorable Price: `"+reportFmt(peak)+"`\n🏆 Highest Profit: *+"+peakPct.toFixed(1)+"%*\n\n🎯 TP1 "+(Number(pos.tp1_hit)?"✅":"❌")+"   TP2 "+(Number(pos.tp2_hit)?"✅":"❌")+"   TP3 "+(Number(pos.tp3_hit)?"✅":"❌")
      : "😔 *SL HIT*\n\n📌 "+pos.pair+" — "+pos.direction+"\n\n💰 SL Price: `"+reportFmt(closePrice)+"`\n📉 Loss: *"+(realizedAtClose>=0?"+":"")+realizedAtClose.toFixed(1)+"%*\n\n🔒 Position Closed";
    try { if (pos.channel_message_id) await sendTelegramReply(this.env,msg,pos.channel_message_id); }
    finally {
      await this.env.DB.prepare("UPDATE signal_positions SET status='CLOSED',closed_at=datetime('now'),close_price=?,realized_profit_pct=?,highest_profit_pct=?,close_reason=?,updated_at=datetime('now') WHERE id=? AND status='CLOSING'").bind(closePrice,reportProfit,peakPct,reason,Number(pos.id)).run();
    }
  }

  async persistPosition(pos) {
    if (!this.env.DB) return;
    await this.env.DB.prepare(`
      UPDATE signal_positions SET tp1_hit=?, tp2_hit=?, tp3_hit=?, highest_price=?, lowest_price=?, status=?, updated_at=datetime('now') WHERE id=?
    `).bind(Number(pos.tp1_hit || 0), Number(pos.tp2_hit || 0), Number(pos.tp3_hit || 0), Number(pos.highest_price || pos.entry_mid), Number(pos.lowest_price || pos.entry_mid), pos.status || "OPEN", Number(pos.id)).run();
  }

  async flushPositionsToD1() {
    for (const pos of this.positions.values()) {
      try { await this.persistPosition(pos); } catch (error) { console.error("OKX MONITOR POSITION FLUSH ERROR", pos.symbol, error); }
    }
  }
}

/* ============================================================
   TELEGRAM API
============================================================ */

async function sendTelegram(env, chatId, text, replyMarkup) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN missing");
    return false;
  }

  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  try {
    const response = await fetch(
      "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );
    if (!response.ok) {
      console.error("TELEGRAM ERROR", response.status, await response.text());
      return false;
    }
    const data = await response.json();
    return data && data.ok ? data.result : false;
  } catch (error) {
    console.error("TELEGRAM FETCH ERROR", error);
    return false;
  }
}

async function sendNewsChannel(env, text) {
  const channel = getEnv(env, "CHANNEL_CHAT_ID", DEFAULTS.CHANNEL_CHAT_ID);
  if (!channel || !env.TELEGRAM_BOT_TOKEN) return false;

  const body = {
    chat_id: channel,
    text: text,
    parse_mode: "Markdown",
    disable_web_page_preview: false
  };

  try {
    const response = await fetch(
      "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );
    if (!response.ok) {
      console.error("TELEGRAM NEWS ERROR", response.status, await response.text());
      return false;
    }
    const data = await response.json();
    return !!(data && data.ok);
  } catch (error) {
    console.error("TELEGRAM NEWS FETCH ERROR", error);
    return false;
  }
}

async function answerCallback(env, callbackId) {
  if (!env.TELEGRAM_BOT_TOKEN || !callbackId) return;

  try {
    await fetch(
      "https://api.telegram.org/bot" +
        env.TELEGRAM_BOT_TOKEN +
        "/answerCallbackQuery",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          callback_query_id: callbackId
        })
      }
    );
  } catch (error) {
    console.error("CALLBACK ANSWER ERROR", error);
  }
}

/* ============================================================
   HELPERS
============================================================ */

function getEnv(env, key, fallback) {
  if (env && env[key] !== undefined && env[key] !== null && env[key] !== "") {
    return env[key];
  }

  return fallback;
}

function getEnvPlaceholder(key, fallback) {
  // Prompts cannot access env directly in pure string builders.
  // The approved defaults are enough for the sales agent.
  return fallback;
}

function isEnabled(env, key, fallback) {
  const value = getEnv(env, key, fallback);

  if (typeof value === "boolean") return value;

  return String(value).toLowerCase() !== "false";
}

function isStopMessage(text) {
  const value = String(text || "").toLowerCase().trim();

  const stopWords = [
    "/stop",
    "stop",
    "stop messages",
    "not interested",
    "no thanks",
    "don't message me",
    "do not message me"
  ];

  return stopWords.indexOf(value) >= 0;
}

function assignedTeamKey(user) {
  const team = assignedTeam(user);
  return team.key;
}

function containsAny(text, words) {
  const value = String(text || "").toLowerCase();

  for (const word of words) {
    if (value.indexOf(String(word).toLowerCase()) >= 0) {
      return true;
    }
  }

  return false;
}

function stripAt(value) {
  return String(value || "").replaceAll("@", "");
}

function escapeMarkdown(value) {
  let text = String(value == null ? "" : value);

  const chars = [
    "_", "*", "[", "]", "`"
  ];

  for (const ch of chars) {
    text = text.split(ch).join("\\" + ch);
  }

  return text;
}

function now() {
  return new Date().toISOString();
}

function textResponse(text, status) {
  return new Response(text, {
    status: status || 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

function jsonResponse(value, status) {
  return new Response(
    JSON.stringify(value, null, 2),
    {
      status: status || 200,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}

function simpleHash(value) {
  let hash = 2166136261;

  const text = String(value || "");

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }

  return (hash >>> 0).toString(16);
}

function fmt(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return "n/a";

  if (number >= 1000) return number.toFixed(2);
  if (number >= 1) return number.toFixed(5);
  return number.toFixed(8);
}

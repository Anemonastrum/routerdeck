import { Router } from 'express';
import {
  getAppSettings,
  getStatusSettings,
  updateAppSettings,
  updateStatusSettings,
  getTelegramSettings,
  updateTelegramSettings,
  getTelegramBotToken,
  getTelegramRecipients,
  createTelegramRecipient,
  updateTelegramRecipient,
  deleteTelegramRecipient,
} from '../db/index.js';
import { createConfigurationBackup, restoreConfigurationBackup } from '../configs/backup.js';
import { sendTelegram } from '../etc/telegram.js';

export function createSettingsRouter() {
  const router = Router();

  router.get('/status-settings', (_req, res) => res.json(getStatusSettings()));
  router.patch('/status-settings', (req, res) => res.json(updateStatusSettings(req.body || {})));
  router.get('/app-settings', (_req, res) => res.json(getAppSettings()));
  router.patch('/app-settings', (req, res) => res.json(updateAppSettings(req.body || {})));

  router.get('/telegram-settings', (_req, res) => {
    res.json({ ...getTelegramSettings(), recipients: getTelegramRecipients() });
  });
  router.patch('/telegram-settings', (req, res) => res.json(updateTelegramSettings(req.body || {})));

  router.post('/telegram/recipients', (req, res) => {
    try { res.status(201).json(createTelegramRecipient(req.body || {})); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.patch('/telegram/recipients/:id', (req, res) => {
    try {
      const recipient = updateTelegramRecipient(Number(req.params.id), req.body || {});
      if (!recipient) return res.status(404).json({ error: 'Telegram recipient not found' });
      res.json(recipient);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.delete('/telegram/recipients/:id', (req, res) => {
    if (!deleteTelegramRecipient(Number(req.params.id))) return res.status(404).json({ error: 'Telegram recipient not found' });
    res.json({ ok: true });
  });

  // Send a test message. Accepts unsaved form values so the user can verify
  // delivery before pressing Save; omitting botToken uses the stored one.
  router.post('/telegram/test', async (req, res) => {
    const body = req.body || {};
    const token = typeof body.botToken === 'string' && body.botToken.trim() ? body.botToken.trim() : getTelegramBotToken();
    const fallback = String(body.chatId || '').trim() || getTelegramSettings().chatId || getTelegramRecipients().find(r => r.enabled)?.chatId || '';
    const chatId = String(body.chatId ?? fallback).trim();
    if (!chatId) return res.status(400).json({ ok: false, error: 'No chat ID configured. Add a chat first.' });
    try {
      const sent = await sendTelegram({
        token, chatId,
        text: '🔔 RouterDeck test message\nTelegram notifications are working.',
      });
      if (!sent.ok) return res.status(502).json({ ok: false, error: sent.error });
      res.json({ ok: true, sentTo: chatId });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  router.post('/config-backup/export', (req, res) => {
    try {
      res.json(createConfigurationBackup(req.body?.password || ''));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/config-backup/restore', (req, res) => {
    try {
      res.json(restoreConfigurationBackup(req.body?.backup, req.body?.password || ''));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  return router;
}

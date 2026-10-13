/**
 * Puente con el sistema de carruseles (carruseles/ en el repo de Antonio Sandoval).
 * No forma parte de OpenReply original.
 *
 *   POST /api/carruseles  { accion: "preparar", slug, palabra, recurso, titulo }
 *     Crea (o actualiza) la campaña de ese carrusel EN ESPERA: con follow gate y el
 *     recurso como enlace, pero sin post asociado, así que todavía no responde a nada.
 *
 *   POST /api/carruseles  { accion: "vincular", slug, mediaId, permalink }
 *     El publicador (Worker de Cloudflare) la llama tras publicar: asocia la campaña al
 *     post y desde ese momento el comentario con la palabra dispara el DM.
 *
 * Auth: Authorization: Bearer <CARRUSELES_TOKEN>.
 * Se vincula a UN post concreto (no «cualquier post»): palabras como META o VIDEO
 * son comunes en español y dispararían DMs en comentarios que no las piden.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { buildInitialCampaignLinks } from "@/lib/campaigns/links";
import { generateReportShareSlug } from "@/lib/reports/share";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";

const preparar = z.object({
  accion: z.literal("preparar"),
  slug: z.string().min(1).max(80),
  palabra: z.string().min(2).max(20),
  recurso: z.string().url(),
  pdf: z.string().url().optional().nullable(),
  titulo: z.string().min(1).max(80),
  nombre: z.string().min(1).max(90).optional(),
  // recurso de tipo repositorio: el enlace de GitHub va escrito en el texto, no en un botón
  repo: z.string().url().optional().nullable(),
  // mensaje de apertura: se decide con la prueba de dos cuentas (Fase 0 del debate)
  apertura: z.boolean().optional(),
});
const vincular = z.object({
  accion: z.literal("vincular"),
  slug: z.string().min(1).max(80),
  mediaId: z.string().min(1),
  permalink: z.string().url().optional().nullable(),
});

const nombre = (slug: string) => `carrusel:${slug}`;

// Flujo aprobado por Antonio tras el debate de 3 agentes (2026-09-29).
// Español neutro, sin {username} (su respaldo es «there» en inglés).
const textos = (nombre: string, palabra: string, repo?: string | null) => ({
  publicReplyMessages: [
    "Te escribí por DM 📩 Si no lo ves, mira en Solicitudes.",
    "Listo, revisa tus mensajes. Si no aparece, está en Solicitudes 👀",
    `Listo ✅ ¿Alguien más lo quiere? Comenta ${palabra} 👇`,
  ],
  openingDmMessage: `¡Hola! Tu guía «${nombre}» está lista 🙌 Pulsa el botón y te la paso.`,
  openingDmButtonLabel: "Quiero la guía",
  followPromptMessage:
    "Un paso más: la guía es para quienes me siguen. Toca mi nombre arriba, pulsa Seguir y vuelve aquí para pulsar el botón. Cada semana publico una guía así para tu tienda, sin spam. Si acabas de seguirme y no te llega, espera unos segundos y pulsa otra vez.",
  followPromptButtonLabel: "Ya te sigo",
  dmMessage: repo
    ? `Aquí tienes «${nombre}» 👇\n\nRepositorio en GitHub:\n${repo}\n\nY la guía corta para instalarlo y usarlo:`
    : `Aquí tienes «${nombre}» 👇`,
  linkButtonLabel: "Ver la guía",
  pdfButtonLabel: "Descargar el PDF",
  followUpMessage:
    "¿Pudiste abrirla? Si te atascas en algún paso, respóndeme con el número y te ayudo. Y cuéntame: ¿qué vendes en tu tienda?",
});

export async function POST(request: NextRequest) {
  const token = process.env.CARRUSELES_TOKEN;
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);

  if (body?.accion === "preparar") {
    const p = preparar.safeParse(body);
    if (!p.success) return NextResponse.json({ ok: false, error: p.error.flatten() }, { status: 400 });
    const cuenta = await prisma.instagramAccount.findFirst({ orderBy: { connectedAt: "desc" } });
    if (!cuenta) return NextResponse.json({ ok: false, error: "No hay cuenta de Instagram conectada" }, { status: 400 });

    const palabra = p.data.palabra.toUpperCase();
    const t = textos(p.data.nombre ?? p.data.titulo, palabra, p.data.repo);
    const apertura = p.data.apertura ?? process.env.CARRUSELES_APERTURA !== "false";
    const datos = {
      goal: "Enviar el recurso del carrusel tras seguir la cuenta",
      keywords: [palabra],
      matchAnyWord: false,
      wholeWordMatch: true,
      requireFollow: true,
      followPromptMessage: t.followPromptMessage,
      followPromptButtonLabel: t.followPromptButtonLabel,
      openingDmEnabled: apertura,
      openingDmMessage: apertura ? t.openingDmMessage : null,
      openingDmButtonLabel: apertura ? t.openingDmButtonLabel : null,
      dmMessage: t.dmMessage,
      linkButtonLabel: t.linkButtonLabel,
      followUpEnabled: true,
      followUpMessage: t.followUpMessage,
      followUpDelayMinutes: 30,
      // Palabras como META o VIDEO saldrían en conversaciones normales con clientes
      dmTriggerEnabled: false,
      publicReplyEnabled: true,
      publicReplyMessages: t.publicReplyMessages,
      publicReplyMessage: t.publicReplyMessages[0],
      isActive: true,
    };
    const existente = await prisma.automation.findFirst({ where: { name: nombre(p.data.slug) } });
    if (existente) {
      await prisma.automation.update({ where: { id: existente.id }, data: datos });
      // el recurso puede haber cambiado de URL; el PDF va como segundo botón
      await prisma.trackedLink.updateMany({
        where: { automationId: existente.id, position: 0 },
        data: { destinationUrl: p.data.recurso },
      });
      if (p.data.pdf) {
        const segundo = await prisma.trackedLink.findFirst({ where: { automationId: existente.id, position: 1 } });
        if (segundo) {
          await prisma.trackedLink.update({ where: { id: segundo.id }, data: { destinationUrl: p.data.pdf, label: t.pdfButtonLabel } });
        } else {
          await prisma.trackedLink.create({ data: { workspaceId: existente.workspaceId, automationId: existente.id,
            slug: generateTrackedLinkSlug(), label: t.pdfButtonLabel, destinationUrl: p.data.pdf, position: 1 } });
        }
      }
      return NextResponse.json({ ok: true, id: existente.id, estado: existente.postId ? "vinculada" : "en espera", actualizada: true, apertura });
    }
    const creada = await prisma.automation.create({
      data: {
        ...datos,
        name: nombre(p.data.slug),
        workspaceId: cuenta.workspaceId,
        instagramAccountId: cuenta.id,
        // en espera: sin post, sin «cualquier post» y sin «siguiente reel» → no responde a nada aún
        postId: null,
        postUrl: null,
        pendingNextReel: false,
        matchAnyPost: false,
        reportShareSlug: generateReportShareSlug(),
        trackedLinks: {
          create: buildInitialCampaignLinks({ workspaceId: cuenta.workspaceId, primaryUrl: p.data.recurso,
            secondaryUrl: p.data.pdf ?? undefined, secondaryLabel: t.pdfButtonLabel }),
        },
      },
    });
    return NextResponse.json({ ok: true, id: creada.id, estado: "en espera", apertura });
  }

  if (body?.accion === "vincular") {
    const v = vincular.safeParse(body);
    if (!v.success) return NextResponse.json({ ok: false, error: v.error.flatten() }, { status: 400 });
    const a = await prisma.automation.findFirst({ where: { name: nombre(v.data.slug) } });
    if (!a) return NextResponse.json({ ok: false, error: `No hay campaña para ${v.data.slug}` }, { status: 404 });
    await prisma.automation.update({
      where: { id: a.id },
      data: { postId: v.data.mediaId, postUrl: v.data.permalink ?? null, isActive: true },
    });
    return NextResponse.json({ ok: true, id: a.id, estado: "vinculada" });
  }

  return NextResponse.json({ ok: false, error: "accion debe ser «preparar» o «vincular»" }, { status: 400 });
}

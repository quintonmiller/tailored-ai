import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message as DiscordMessage,
  EmbedBuilder,
  ComponentType,
} from "discord.js";
import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from "../approval.js";

const APPROVAL_TIMEOUT_MS = 300_000; // 5 minutes

/** Function that sends an approval embed and returns the sent message. */
export type SendApprovalEmbed = (options: {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}) => Promise<DiscordMessage>;

export class DiscordApprovalHandler implements ApprovalHandler {
  private sendEmbed: SendApprovalEmbed;
  private userId: string;

  constructor(sendEmbed: SendApprovalEmbed, userId: string) {
    this.sendEmbed = sendEmbed;
    this.userId = userId;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    const startTime = Date.now();

    const embed = new EmbedBuilder()
      .setTitle("Tool Approval Required")
      .setDescription(request.description)
      .addFields(
        { name: "Tool", value: request.toolName, inline: true },
        { name: "Request ID", value: request.requestId, inline: true },
      )
      .setColor(0xffa500)
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${request.requestId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reject_${request.requestId}`)
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger),
    );

    const approvalMsg = await this.sendEmbed({
      embeds: [embed],
      components: [row],
    });

    try {
      const interaction = await approvalMsg.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: APPROVAL_TIMEOUT_MS,
        filter: (i) => i.user.id === this.userId,
      });

      const approved = interaction.customId.startsWith("approve_");
      const responseTimeMs = Date.now() - startTime;

      // Update the message to show the result
      const resultEmbed = EmbedBuilder.from(embed)
        .setColor(approved ? 0x00ff00 : 0xff0000)
        .setTitle(approved ? "Approved" : "Rejected");

      await interaction.update({ embeds: [resultEmbed], components: [] }).catch(() => {});

      return { approved, responseTimeMs };
    } catch {
      // Timeout — no interaction received
      const resultEmbed = EmbedBuilder.from(embed)
        .setColor(0x808080)
        .setTitle("Approval Timed Out");

      await approvalMsg.edit({ embeds: [resultEmbed], components: [] }).catch(() => {});

      return {
        approved: false,
        reason: "approval timed out (no response)",
        responseTimeMs: Date.now() - startTime,
      };
    }
  }
}

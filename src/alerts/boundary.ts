/**
 * Capability boundary alert system.
 *
 * Generates alerts when an agent attempts actions that exceed its
 * delegated permissions.
 */

import type { BoundaryViolation } from '../types/events';
import type { AgentCapability } from '../types/agent';
import type { DelegationRule } from '../types/delegation';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface BoundaryAlert {
  violation: BoundaryViolation;
  severity: AlertSeverity;
  title: string;
  message: string;
  allowOneTimeOverride: boolean;
  acknowledged: boolean;
}

const SENSITIVE_URL_PATTERNS = [
  /\.bank\./i,
  /\.gov\./i,
  /paypal/i,
  /stripe/i,
  /\.financial/i,
  /healthcare/i,
  /\.mil\./i,
];

/**
 * Create a boundary alert from a violation.
 */
export function createBoundaryAlert(
  violation: BoundaryViolation,
  rule: DelegationRule
): BoundaryAlert {
  const severity = classifyViolationSeverity(violation.attemptedAction, violation.url);
  const title = generateAlertTitle(violation.attemptedAction);
  const message = generateAlertMessage(violation, rule.label ?? rule.preset);

  return {
    violation,
    severity,
    title,
    message,
    allowOneTimeOverride: severity === 'medium' || severity === 'low',
    acknowledged: false,
  };
}

/**
 * Determine the severity of a capability violation.
 */
export function classifyViolationSeverity(
  capability: AgentCapability,
  url: string
): AlertSeverity {
  const baseSeverityMap: Record<AgentCapability, AlertSeverity> = {
    'submit-form': 'critical',
    'execute-script': 'critical',
    'download-file': 'high',
    'modify-dom': 'high',
    'network-request': 'high',
    click: 'high',
    'type-text': 'medium',
    navigate: 'medium',
    'open-tab': 'low',
    'close-tab': 'low',
    'read-dom': 'low',
    screenshot: 'low',
  };

  let severity = baseSeverityMap[capability] ?? 'medium';

  // Upgrade severity for sensitive URLs
  const isSensitive = SENSITIVE_URL_PATTERNS.some((pattern) => pattern.test(url));
  if (isSensitive) {
    const upgrade: Record<AlertSeverity, AlertSeverity> = {
      low: 'medium',
      medium: 'high',
      high: 'critical',
      critical: 'critical',
    };
    severity = upgrade[severity];
  }

  return severity;
}

/**
 * Generate a human-readable alert title.
 */
export function generateAlertTitle(capability: AgentCapability): string {
  const titles: Record<AgentCapability, string> = {
    navigate: 'Navigation blocked',
    'read-dom': 'Page read blocked',
    click: 'Click interaction blocked',
    'type-text': 'Text input blocked',
    'submit-form': 'Form submission blocked',
    'download-file': 'File download blocked',
    'open-tab': 'New tab blocked',
    'close-tab': 'Tab closure blocked',
    screenshot: 'Screenshot blocked',
    'execute-script': 'Script execution blocked',
    'modify-dom': 'DOM modification blocked',
    'network-request': 'Network request blocked',
  };
  return titles[capability] || 'Action blocked';
}

/**
 * Generate a detailed alert message.
 */
export function generateAlertMessage(
  violation: BoundaryViolation,
  ruleName: string
): string {
  const lines = [
    `An agent attempted to perform "${violation.attemptedAction}" on:`,
    violation.url,
    '',
    `Blocked by rule: ${ruleName}`,
    `Reason: ${violation.reason}`,
  ];

  if (violation.targetSelector) {
    lines.push(`Target element: ${violation.targetSelector}`);
  }

  return lines.join('\n');
}

/**
 * Handle a user's one-time override of a blocked action.
 */
export function handleOneTimeOverride(
  alertId: string,
  violation: BoundaryViolation
): BoundaryViolation {
  return { ...violation, userOverride: true };
}

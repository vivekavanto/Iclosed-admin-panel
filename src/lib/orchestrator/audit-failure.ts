export type AuditStage='capture'|'review'|'publish';
export interface AuditFailureInfo { stage:AuditStage; code:string; httpStatus?:number; requestId?:string; }
export class AuditFailure extends Error {
  info:Omit<AuditFailureInfo,'stage'>;
  constructor(info:Omit<AuditFailureInfo,'stage'>){super(info.code);this.name='AuditFailure';this.info=info;}
}
const codes=new Set(['credit_balance_exhausted','insufficient_quota','rate_limit_exceeded','invalid_api_key','model_not_found','invalid_json_schema','invalid_request_error','context_length_exceeded','provider_error','max_output_tokens','refused','invalid_response','timeout','capture_failed','review_failed','publish_failed']);
export function safeAuditFailure(error:unknown,stage:AuditStage):AuditFailureInfo {
  const info=error instanceof AuditFailure?error.info:undefined;
  return {stage,code:info&&codes.has(info.code)?info.code:stage+'_failed',
    ...(info&&Number.isInteger(info.httpStatus)?{httpStatus:info.httpStatus}:{}),
    ...(info?.requestId&&/^[a-zA-Z0-9_-]{1,120}$/.test(info.requestId)?{requestId:info.requestId}:{})};
}
export function auditFailureMessage(info:AuditFailureInfo) {
  if(info.code==='credit_balance_exhausted')return 'AI review failed. OpenAI API credit balance is exhausted. Add API credits in the project billing settings, then request a manual rerun. No automatic paid retry was made.';
  const reason:Record<string,string>={insufficient_quota:'OpenAI API credits or project spending quota are exhausted. Check API billing before retrying.',rate_limit_exceeded:'OpenAI rate limit reached. Wait before requesting a manual rerun.',invalid_api_key:'OpenAI rejected the configured API key.',model_not_found:'The configured OpenAI model is unavailable to this project.',invalid_json_schema:'OpenAI rejected the audit response schema. The application request needs correction.',invalid_request_error:'OpenAI rejected the audit request. Check the request configuration.',context_length_exceeded:'The captured evidence exceeds the model context limit.',max_output_tokens:'OpenAI reached the configured output/reasoning token limit before completing the audit.',refused:'OpenAI did not return an audit result.',timeout:'The audit provider request timed out.',provider_error:'The OpenAI provider request failed.',invalid_response:'The audit provider returned an invalid or incomplete report.'};
  return `${info.stage==='capture'?'Document capture':info.stage==='review'?'AI review':'Report save'} failed. ${reason[info.code]??'The operation did not complete.'} Existing reports were retained; no automatic paid retry was made.`;
}

import {cooSubmissionGuidance} from "./submission-guidance.ts";
export type CooDeliveryStatus="review"|"sending"|"sent"|"uncertain"|"failed";
export interface CooReviewSummary{id:string;hash:string;status:CooDeliveryStatus;createdAt:string;sentAt?:string;error?:string;}
export function cooRegisterAction(address:string,type:string,review?:CooReviewSummary){
 if(cooSubmissionGuidance(address))return {label:"Client only",hint:"Clients must submit for Mississauga",action:false};
 return {label:review?.status==='sent'?'Sent':review?'Review':type==='refinance'?'Review':'Prepare COO',hint:review?.status==='sent'?'Email accepted by the sending provider':review?.status==='uncertain'?'Delivery needs reconciliation before retrying':'',action:!review&&type!=='refinance'};
}

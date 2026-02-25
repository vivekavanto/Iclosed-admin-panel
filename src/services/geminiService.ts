import { GoogleGenAI } from "@google/genai";
import { Deal } from '../types';

let ai: GoogleGenAI | null = null;

const getAIClient = () => {
  if (!ai) {
    // In a real app, ensure this is handled securely.
    // For this environment, we assume process.env.API_KEY is available.
    if (process.env.API_KEY) {
      ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    }
  }
  return ai;
};

export const generateClientEmail = async (deal: Deal, customInstruction?: string): Promise<string> => {
  const client = getAIClient();
  if (!client) return "Error: API Key not configured.";

  const prompt = `
    You are a professional legal assistant at the law firm "Nava Wilson", specifically the "iClosed" division.
    Write a polite, professional, and concise email to the client named ${deal.client.firstName} ${deal.client.lastName}.
    
    Context:
    - Transaction: ${deal.type} of ${deal.propertyAddress}.
    - Closing Date: ${deal.closingDate}.
    - Current Progress: ${deal.progress}%.
    - Completed Tasks: ${deal.tasks.filter(t => t.completed).map(t => t.title).join(', ') || 'None'}.
    - Outstanding Tasks: ${deal.tasks.filter(t => !t.completed).map(t => t.title).join(', ') || 'None'}.
    
    Instruction:
    ${customInstruction || 'Provide a general status update.'}

    Do not include a subject line unless asked. Just the body.
    Sign off as "The iClosed Team".
  `;

  try {
    const response = await client.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
    });
    return response.text || "Failed to generate email.";
  } catch (error) {
    console.error("Gemini API Error:", error);
    return "Error generating email. Please try again later.";
  }
};

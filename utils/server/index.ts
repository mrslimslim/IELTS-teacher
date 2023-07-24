import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { AZURE_DEPLOYMENT_ID, OPENAI_API_HOST, OPENAI_API_TYPE, OPENAI_API_VERSION, OPENAI_ORGANIZATION } from '../app/const';

import {
  ParsedEvent,
  ReconnectInterval,
  createParser,
} from 'eventsource-parser';

export class OpenAIError extends Error {
  type: string;
  param: string;
  code: string;

  constructor(message: string, type: string, param: string, code: string) {
    super(message);
    this.name = 'OpenAIError';
    this.type = type;
    this.param = param;
    this.code = code;
  }
}

export const OpenAIStream = async (
  model: OpenAIModel,
  systemPrompt: string,
  temperature : number,
  key: string,
  messages: Message[],
) => {
  let url = `${OPENAI_API_HOST}/v1/chat/completions`;
  if (OPENAI_API_TYPE === 'azure') {
    url = `${OPENAI_API_HOST}/openai/deployments/${AZURE_DEPLOYMENT_ID}/chat/completions?api-version=${OPENAI_API_VERSION}`;
  }
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(OPENAI_API_TYPE === 'openai' && {
        Authorization: `Bearer ${key ? key : process.env.OPENAI_API_KEY}`
      }),
      ...(OPENAI_API_TYPE === 'azure' && {
        'api-key': `${key ? key : process.env.OPENAI_API_KEY}`
      }),
      ...((OPENAI_API_TYPE === 'openai' && OPENAI_ORGANIZATION) && {
        'OpenAI-Organization': OPENAI_ORGANIZATION,
      }),
    },
    method: 'POST',
    body: JSON.stringify({
      ...(OPENAI_API_TYPE === 'openai' && {model: model.id}),
      messages: [
        {
          role: 'system',
          content: `{
            "name": "IELTS Writing Excellence Assessor",
            "description": "This assessor is an expert in evaluating IELTS writing tasks, utilizing a deep understanding of IELTS writing standards and significant experience in guiding students towards superior writing skills and improved IELTS scores.",
            "evaluationCriteria": {
                "Task Achievement": {
                    "description": "Assesses the extent to which the input answers the question, maintaining a clear position throughout, including supportive details and examples.",
                    "scoreRange": "0-9"
                },
                "Coherence and Cohesion": {
                    "description": "Examines logical organization, effective paragraphing, clearly defined central ideas for each paragraph, and appropriate use of cohesive devices.",
                    "scoreRange": "0-9"
                },
                "Lexical Resource": {
                    "description": "Evaluates the range and precision of vocabulary, suitability of word choice, and the diversity in language use.",
                    "scoreRange": "0-9"
                },
                "Grammatical Range and Accuracy": {
                    "description": "Investigates the range and accuracy of grammatical structures, considering any grammatical errors, and the complexity of grammar used.",
                    "scoreRange": "0-9"
                }
            },
            "inputParams": {
                "%question": "The provided IELTS writing question is represented as '%question'.",
                "%answer": "The student's response to the question is represented as '%answer'."
            },
            "outputs": {
                "score": {
                    "description": "The score given to the student's writing based on the IELTS writing criteria.",
                    "range": "0-9",
                    "score": "%number between 0-9"
                },
                "scoringRationale": {
                    "description": "An explanation for the score under each evaluation criterion and an overall justification in accordance with IELTS writing standards.",
                    "outputExample": [
                        {
                            "criterion": "Task Fulfillment",
                            "score": "%number between 0-9",
                            "rationale": "The student's response is well-structured and thoroughly developed, showcasing a clear viewpoint and inclusive of relevant details and examples."
                        },
                        {
                            "criterion": "Coherence and Cohesion",
                            "score": "%number between 0-9",
                            "rationale": "The student's response is logically structured, with a clear central theme within each paragraph and apt use of cohesive devices."
                        },
                        {
                            "criterion": "Lexical Resource",
                            "score": "%number between 0-9",
                            "rationale": "The student's response demonstrates a wide range of vocabulary, with appropriate word selection and lexical variations."
                        },
                        {
                            "criterion": "Grammatical Range and Accuracy",
                            "score": "%number between 0-9",
                            "rationale": "The student's response demonstrates a wide range of grammar, with few grammatical errors and the complexity of used grammatical structures."
                        },
                        {
                            "criterion": "Overall",
                            "score": "%number between 0-9",
                            "rationale": "The overall student's response is coherently organized, well-elaborated, exhibits broad range of vocabulary and grammar with minimal errors."
                        }
                    ]
                },
                "errorSentenceRevision": {
                    "description": "Revisions of the student's writing based on IELTS standards, presented in markdown format with erroneous parts highlighted.",
                    "outputFormat": "markdown table format",
                    "outputRequirements": [
                        "Only sentences with errors need to be included. Sentences without errors should be ignored in the output.",
                        "The output should be in HTML Table format. The revised words or sentences should be highlighted using the <span> tag with a style attribute of 'color:#7B68EE;background:black'."
                    ],
                    "outputExample": [{
                        "original": "%(the original sentence)",
                        "revised": "%(the revised sentence)",
                        "reason": "%(the reason for revision)",
                        "errorType": "%(the type of error)"
                    }]
                },
                "benchmarkEssay": {
                    "description": "A model essay adhering to IELTS writing standards that showcases an ideal response, presented in markdown format.",
                    "outputFormat": "markdown"
                }
            },
            "requirements": [
                "DO REMEMBER OUTPUT THE RESULT IN **markdown** FORMAT."
            ]
        }
        `,
        },
        ...messages,
      ],
      max_tokens: 4000,
      temperature: 0,
      stream: true,
      model: 'gpt-3.5-turbo-16k',
    }),
  });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  if (res.status !== 200) {
    const result = await res.json();
    if (result.error) {
      throw new OpenAIError(
        result.error.message,
        result.error.type,
        result.error.param,
        result.error.code,
      );
    } else {
      throw new Error(
        `OpenAI API returned an error: ${
          decoder.decode(result?.value) || result.statusText
        }`,
      );
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      const onParse = (event: ParsedEvent | ReconnectInterval) => {
        if (event.type === 'event') {
          const data = event.data;

          try {
            const json = JSON.parse(data);
            if (json.choices[0].finish_reason != null) {
              controller.close();
              return;
            }
            const text = json.choices[0].delta.content;
            const queue = encoder.encode(text);
            controller.enqueue(queue);
          } catch (e) {
            controller.error(e);
          }
        }
      };

      const parser = createParser(onParse);

      for await (const chunk of res.body as any) {
        parser.feed(decoder.decode(chunk));
      }
    },
  });

  return stream;
};

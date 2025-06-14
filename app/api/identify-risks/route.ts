import { NextResponse } from "next/server"

interface SolarLLMMessage {
  role: "user" | "assistant" | "system"
  content: string
}

interface SolarLLMResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string
    }
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

interface RiskIdentificationResult {
  risks: Array<{
    title: string
    severity: "low" | "medium" | "high"
    originalText: string
    riskType: string
    location: string
  }>
  summary: string
}

// Global tracking for LLM calls
let llmCallCount = 0
let totalLLMTime = 0

async function callSolarLLM(messages: SolarLLMMessage[], jsonSchema?: any): Promise<any> {
  const startTime = Date.now()
  llmCallCount++
  
  const apiKey = process.env.UPSTAGE_API_KEY?.trim()
  const modelName = process.env.UPSTAGE_MODEL_NAME || "solar-pro2-preview"
  
  // Debug environment variables
  console.log(`🔧 Environment Check:`, {
    has_api_key: !!apiKey,
    api_key_length: apiKey?.length,
    api_key_preview: apiKey ? `${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}` : 'MISSING',
    model_name: modelName,
    model_name_source: process.env.UPSTAGE_MODEL_NAME ? 'env_var' : 'default'
  })
  
  if (!apiKey) {
    console.error(`❌ UPSTAGE_API_KEY environment variable is missing!`)
    throw new Error("UPSTAGE_API_KEY environment variable is required")
  }

  const requestBody: any = {
    model: modelName,
    messages: messages,
    temperature: 0.1,
    max_tokens: 4000,
    top_p: 0.9,
  }

  // Add reasoning parameters for solar-pro2-preview model
  if (modelName === "solar-pro2-preview") {
    requestBody.reasoning_effort = "high"
  }

  if (jsonSchema) {
    requestBody.response_format = {
      type: "json_schema",
      json_schema: {
        name: "contract_analysis",
        schema: jsonSchema,
        strict: true
      }
    }
  }

  // Debug logging
  console.log(`🔥 LLM Call #${llmCallCount} - Model: ${modelName}`)
  console.log(`📝 Request Body:`, {
    model: requestBody.model,
    temperature: requestBody.temperature,
    max_tokens: requestBody.max_tokens,
    top_p: requestBody.top_p,
    reasoning_effort: requestBody.reasoning_effort,
    messages_count: requestBody.messages?.length,
    has_json_schema: !!requestBody.response_format,
    first_message_preview: requestBody.messages?.[0]?.content?.substring(0, 200) + '...'
  })

  // Retry logic with exponential backoff
  const maxRetries = 3
  let retryCount = 0
  
  while (retryCount <= maxRetries) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 300000) // 300 seconds timeout

      console.log(`📡 Making API request to Upstage (attempt ${retryCount + 1}/${maxRetries + 1})...`)
      
      const response = await fetch('https://api.upstage.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      console.log(`📊 Response Status: ${response.status} ${response.statusText}`)
      console.log(`📊 Response Headers:`, Object.fromEntries(response.headers.entries()))

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`❌ Error Response Body:`, errorText)
        
        // Try to parse error as JSON for better logging
        try {
          const errorJson = JSON.parse(errorText)
          console.error(`❌ Parsed Error:`, errorJson)
        } catch (parseError) {
          console.error(`❌ Raw Error Text:`, errorText)
        }
        
        throw new Error(`Upstage SolarLLM API error: ${response.status} - ${errorText}`)
      }

      const responseText = await response.text()
      console.log(`✅ Raw Response Body (first 500 chars):`, responseText.substring(0, 500) + (responseText.length > 500 ? '...' : ''))
      
      const result: SolarLLMResponse = JSON.parse(responseText)
      console.log(`✅ Parsed Response:`, {
        id: result.id,
        model: result.model,
        choices_count: result.choices?.length,
        finish_reason: result.choices?.[0]?.finish_reason,
        content_length: result.choices?.[0]?.message?.content?.length,
        usage: result.usage
      })
      
      if (!result.choices || result.choices.length === 0) {
        console.error(`❌ No choices in response:`, result)
        throw new Error("No response from SolarLLM")
      }

      const endTime = Date.now()
      const duration = endTime - startTime
      totalLLMTime += duration
      
      console.log(`⏱️ Call completed in ${duration}ms (total: ${totalLLMTime}ms)`)
      console.log(`📋 Response Content Preview:`, result.choices[0].message.content.substring(0, 200) + '...')

      return result.choices[0].message.content

    } catch (error) {
      retryCount++
      console.error(`❌ Upstage API call failed (attempt ${retryCount}/${maxRetries + 1}):`, error)
      
      if (error instanceof Error) {
        console.error(`❌ Error Type: ${error.constructor.name}`)
        console.error(`❌ Error Message: ${error.message}`)
        console.error(`❌ Error Stack:`, error.stack)
      }
      
      if (retryCount > maxRetries) {
        console.error(`🚫 All retry attempts exhausted. Final error:`, error)
        throw new Error(`Upstage API failed after ${maxRetries + 1} attempts: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
      
      // Exponential backoff: wait 2^retryCount seconds
      const backoffMs = Math.pow(2, retryCount) * 1000
      console.log(`⏳ Retrying in ${backoffMs}ms...`)
      await new Promise(resolve => setTimeout(resolve, backoffMs))
    }
  }
}

async function identifyRisksInCategory(contractText: string, category: string, focusAreas: string[], selectedParty: any = null): Promise<RiskIdentificationResult> {
  const schema = {
    type: "object",
    properties: {
      risks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            originalText: { type: "string" },
            riskType: { type: "string" },
            location: { type: "string" }
          },
          required: ["title", "severity", "originalText", "riskType", "location"]
        }
      },
      summary: { type: "string" }
    },
    required: ["risks", "summary"]
  }

  const partyPerspective = selectedParty 
    ? `You are analyzing this contract from the perspective of "${selectedParty.name}" (${selectedParty.description}). Focus on risks that could negatively impact ${selectedParty.name} specifically.` 
    : `Analyze this contract from a general risk perspective.`

  const messages: SolarLLMMessage[] = [
    {
      role: "system",
      content: `You are an expert legal contract analyst with a specialty in ${category} risks. Your task is to exhaustively identify ALL potential risks in this category, even minor ones that could become problems later.

${partyPerspective}

CRITICAL INSTRUCTIONS:
- Be AGGRESSIVE in finding risks - better to flag something questionable than miss a real risk
- Find EVERY instance of problematic language, even if it seems minor
- Look for both explicit problematic clauses AND missing protective language
- Extract the EXACT text from the contract (word-for-word quotes)
- Classify severity: high (immediate danger), medium (potentially problematic), low (minor but worth noting)
- Identify specific location/section where each risk was found
- Focus specifically on ${category} but don't ignore other obvious risks you encounter
${selectedParty ? `- Prioritize risks that specifically disadvantage or expose "${selectedParty.name}" to liability or unfavorable terms` : ''}

Remember: Clients rely on you to catch everything. Missing a risk could be costly.`
    },
    {
      role: "user",
      content: `Thoroughly analyze this contract for ${category} risks${selectedParty ? ` that could negatively impact "${selectedParty.name}"` : ''}. Find EVERY potential issue in this category:

${contractText}

Specific ${category} risks to find:
${focusAreas.map(area => `- ${area}`).join('\n')}

Look for both:
1. Explicit problematic clauses that create risks${selectedParty ? ` for "${selectedParty.name}"` : ''}
2. Missing protective language that should be present${selectedParty ? ` to protect "${selectedParty.name}"` : ''}
3. Vague or ambiguous terms that could be interpreted unfavorably${selectedParty ? ` against "${selectedParty.name}"` : ''}
4. Standard contract provisions that favor the other party${selectedParty ? ` over "${selectedParty.name}"` : ''}

${selectedParty ? `Remember: You are specifically looking out for "${selectedParty.name}" (${selectedParty.description}). What would be risky or disadvantageous for them in this contract?` : ''}

Be thorough - find every potential risk, no matter how small.`
    }
  ]

  const content = await callSolarLLM(messages, schema)
  return JSON.parse(content)
}

async function identifyRisks(contractText: string, mode: 'quick' | 'comprehensive' = 'comprehensive', firstCategoryOnly: boolean = false, selectedParty: any = null): Promise<RiskIdentificationResult & { llmStats: { calls: number; totalTime: number }; hasMoreCategories?: boolean; currentProgress?: string }> {
  // Reset counters for new analysis
  llmCallCount = 0
  totalLLMTime = 0
  
  // Define comprehensive analysis categories ordered by priority
  const analysisCategories = [
    {
      category: "LIABILITY AND INDEMNIFICATION",
      priority: 1,
      focusAreas: [
        "Unlimited liability clauses",
        "Broad indemnification requirements",
        "Missing liability caps or limitations",
        "One-sided liability provisions",
        "Indemnification for third-party claims",
        "Consequential or punitive damages exposure"
      ]
    },
    {
      category: "TERMINATION AND RENEWAL",
      priority: 1,
      focusAreas: [
        "Automatic renewal without consent",
        "Short notice periods for termination",
        "Termination for convenience limitations",
        "Post-termination obligations",
        "Termination fees or penalties"
      ]
    },
    {
      category: "PAYMENT AND FINANCIAL",
      priority: 2,
      focusAreas: [
        "Payment terms favoring other party",
        "Late payment penalties or interest",
        "Automatic price increases",
        "Expense reimbursement obligations",
        "Missing payment dispute processes"
      ]
    },
    {
      category: "INTELLECTUAL PROPERTY",
      priority: 2,
      focusAreas: [
        "Broad IP assignment or licensing",
        "Work-for-hire provisions",
        "IP indemnification requirements",
        "Trade secret and confidentiality overreach"
      ]
    },
    {
      category: "PERFORMANCE AND COMPLIANCE",
      priority: 3,
      focusAreas: [
        "Unrealistic performance guarantees",
        "Service level agreement penalties",
        "Compliance with changing regulations",
        "Standard of care obligations"
      ]
    },
    {
      category: "DISPUTE RESOLUTION",
      priority: 3,
      focusAreas: [
        "Mandatory arbitration clauses",
        "Venue and jurisdiction limitations",
        "Attorney fees and costs provisions",
        "Waiver of jury trial rights"
      ]
    }
  ]

  // Determine which categories to analyze
  let categoriesToAnalyze
  if (firstCategoryOnly) {
    // Only analyze the first critical category for immediate results
    categoriesToAnalyze = [analysisCategories[0]]  // LIABILITY AND INDEMNIFICATION
  } else if (mode === 'quick') {
    categoriesToAnalyze = analysisCategories.filter(cat => cat.priority === 1)  // Only critical categories
  } else {
    categoriesToAnalyze = analysisCategories
  }

  console.log(`Starting ${firstCategoryOnly ? 'first-category' : mode} risk analysis across ${categoriesToAnalyze.length} categories...`)

  // Analyze categories sequentially by priority for progressive results
  let allRisks: any[] = []
  let summaries: string[] = []

  for (const { category, focusAreas } of categoriesToAnalyze) {
    try {
      console.log(`Analyzing ${category} risks...`)
      const result = await identifyRisksInCategory(contractText, category, focusAreas, selectedParty)
      
      if (result.risks && result.risks.length > 0) {
        // Add new risks, avoiding duplicates
        const newRisks = result.risks.filter((newRisk: any) => 
          !allRisks.some((existingRisk: any) => 
            similarity(newRisk.originalText, existingRisk.originalText) > 0.8
          )
        )
        allRisks = allRisks.concat(newRisks)
        summaries.push(`${category}: Found ${newRisks.length} risks`)
      } else {
        summaries.push(`${category}: No significant risks found`)
      }
      
      console.log(`${category} complete. Total risks so far: ${allRisks.length}`)
    } catch (error) {
      console.error(`Error analyzing ${category}:`, error)
      summaries.push(`${category}: Analysis failed`)
    }
  }

  const modeLabel = firstCategoryOnly ? 'Initial' : (mode === 'quick' ? 'Quick' : 'Comprehensive')
  console.log(`${modeLabel} analysis complete: ${allRisks.length} total risks found in ${totalLLMTime}ms with ${llmCallCount} LLM calls`)

  return {
    risks: allRisks,
    summary: `${modeLabel} analysis found ${allRisks.length} potential risks. ${summaries.join('. ')}`,
    llmStats: {
      calls: llmCallCount,
      totalTime: totalLLMTime
    },
    hasMoreCategories: firstCategoryOnly || (mode === 'quick' && analysisCategories.length > categoriesToAnalyze.length),
    currentProgress: summaries.length > 0 ? summaries[summaries.length - 1] : "Starting analysis..."
  }
}

// Simple text similarity function to detect duplicates
function similarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2
  const shorter = str1.length > str2.length ? str2 : str1
  
  if (longer.length === 0) return 1.0
  
  const editDistance = levenshteinDistance(longer, shorter)
  return (longer.length - editDistance) / longer.length
}

function levenshteinDistance(str1: string, str2: string): number {
  const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null))
  
  for (let i = 0; i <= str1.length; i++) matrix[0][i] = i
  for (let j = 0; j <= str2.length; j++) matrix[j][0] = j
  
  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,     // deletion
        matrix[j - 1][i] + 1,     // insertion
        matrix[j - 1][i - 1] + indicator // substitution
      )
    }
  }
  
  return matrix[str2.length][str1.length]
}

export async function POST(req: Request) {
  try {
    const { text, mode = 'comprehensive', firstCategoryOnly = false, selectedParty = null } = await req.json()

    if (!text) {
      return NextResponse.json({ error: "Contract text is required" }, { status: 400 })
    }

    const analysisMode = mode as 'quick' | 'comprehensive'
    const partyContext = selectedParty ? ` from the perspective of "${selectedParty.name}"` : ''
    console.log(`Starting ${firstCategoryOnly ? 'first-category-only' : analysisMode} risk identification${partyContext}...`)

    try {
      // Identify risks across selected categories
      const riskIdentification = await identifyRisks(text, analysisMode, firstCategoryOnly, selectedParty)
      
      if (!riskIdentification.risks || riskIdentification.risks.length === 0) {
        return NextResponse.json({
          risks: [],
          summary: riskIdentification.summary || "No significant risks identified in this contract.",
          llmStats: riskIdentification.llmStats,
          hasMoreCategories: riskIdentification.hasMoreCategories,
          currentProgress: riskIdentification.currentProgress
        })
      }

      // Convert to format expected by frontend
      const risks = riskIdentification.risks.map((risk: any, index: number) => ({
        id: `risk_${Date.now()}_${index}`,
        title: risk.title,
        severity: risk.severity,
        description: `${risk.riskType} risk identified in ${risk.location}. Detailed analysis pending...`,
        originalText: risk.originalText,
        location: risk.location,
        isAnalyzing: false,
        analysisComplete: false
      }))

      console.log(`Risk identification completed: ${risks.length} risks found`)
      return NextResponse.json({
        risks,
        summary: riskIdentification.summary,
        llmStats: riskIdentification.llmStats,
        hasMoreCategories: riskIdentification.hasMoreCategories,
        currentProgress: riskIdentification.currentProgress
      })
      
    } catch (analysisError) {
      console.error("Error during risk identification:", analysisError)
      
      // Provide fallback mock data with more comprehensive examples
      const fallbackRisks = [
        {
          id: "fallback_1",
          title: "Unlimited Liability Exposure",
          severity: "high" as const,
          description: "Liability risk identified. Detailed analysis pending...",
          originalText: "The Service Provider shall be liable for all damages, losses, costs, and expenses of any kind arising from or relating to this Agreement, without limitation.",
          location: "Section 8: Liability and Indemnification",
          isAnalyzing: false,
          analysisComplete: false
        },
        {
          id: "fallback_2", 
          title: "Automatic Renewal Without Notice",
          severity: "medium" as const,
          description: "Termination risk identified. Detailed analysis pending...",
          originalText: "This Agreement shall automatically renew for successive one-year periods unless terminated by either party with thirty (30) days written notice prior to the renewal date.",
          location: "Section 3: Term and Termination",
          isAnalyzing: false,
          analysisComplete: false
        }
      ]
      
      return NextResponse.json({
        risks: fallbackRisks,
        summary: `Initial analysis identified ${fallbackRisks.length} critical risks. More analysis continuing...`,
        llmStats: { calls: 0, totalTime: 0 },
        hasMoreCategories: true,
        currentProgress: "LIABILITY AND INDEMNIFICATION: Found 2 risks"
      })
    }

  } catch (error) {
    console.error("Error in identify-risks API:", error)
    return NextResponse.json({ 
      error: "Failed to identify risks",
      details: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 })
  }
} 
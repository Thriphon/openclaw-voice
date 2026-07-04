import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  Platform,
  SafeAreaView,
  StatusBar,
  Animated,
  KeyboardAvoidingView,
  Keyboard,
} from 'react-native';
import { Audio } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ChatMarkdown from './ChatMarkdown';

// Types
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface Config {
  serverUrl: string;
  token: string;
  sessionKey: string;
  voice: string;
  ttsEnabled: boolean;
}

const AVAILABLE_VOICES = [
  { id: 'nova', name: 'Nova', description: 'Warm female' },
  { id: 'alloy', name: 'Alloy', description: 'Neutral balanced' },
  { id: 'echo', name: 'Echo', description: 'Smooth male' },
  { id: 'fable', name: 'Fable', description: 'British accent' },
  { id: 'onyx', name: 'Onyx', description: 'Deep male' },
  { id: 'shimmer', name: 'Shimmer', description: 'Soft female' },
  { id: 'ash', name: 'Ash', description: 'Clear neutral' },
  { id: 'coral', name: 'Coral', description: 'Friendly warm' },
  { id: 'sage', name: 'Sage', description: 'Calm wise' },
];

// Main App
export default function App() {
  // State
  const [isConfigured, setIsConfigured] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [inputHeight, setInputHeight] = useState(0);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  
  // Audio queue for sequential playback.
  // Holds pending base64-conversion promises so the (potentially heavy) byte
  // conversion happens off the critical path and chunks still play in order.
  const audioQueueRef = useRef<Promise<string | null>[]>([]);
  const isPlayingRef = useRef(false);
  
  // Reconnect state
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;
  const shouldReconnectRef = useRef(true);

  // Load config on mount
  useEffect(() => {
    loadConfig();
  }, []);

  // Pulse animation for recording
  useEffect(() => {
    if (isRecording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isRecording]);

  // Auto-scroll to bottom
  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages]);

  const loadConfig = async () => {
    try {
      const serverUrl = await AsyncStorage.getItem('serverUrl');
      const token = await AsyncStorage.getItem('token');
      const sessionKey = await AsyncStorage.getItem('sessionKey');
      const voice = await AsyncStorage.getItem('voice');
      const ttsEnabledRaw = await AsyncStorage.getItem('ttsEnabled');
      
      if (serverUrl && token) {
        setConfig({
          serverUrl,
          token,
          sessionKey: sessionKey || 'voice:mobile',
          voice: voice || 'nova',
          ttsEnabled: ttsEnabledRaw === null ? true : ttsEnabledRaw === 'true',
        });
        setIsConfigured(true);
      }
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  };

  const saveConfig = async (newConfig: Config) => {
    try {
      // Debug removed
      await AsyncStorage.setItem('serverUrl', newConfig.serverUrl || '');
      // Debug removed
      await AsyncStorage.setItem('token', newConfig.token || '');
      // Debug removed
      await AsyncStorage.setItem('sessionKey', newConfig.sessionKey || 'voice:mobile');
      // Debug removed
      await AsyncStorage.setItem('voice', newConfig.voice || 'nova');
      await AsyncStorage.setItem('ttsEnabled', String(newConfig.ttsEnabled !== false));
      // Debug removed
      
      // Small delay to ensure storage is committed before state change
      await new Promise(resolve => setTimeout(resolve, 100));
      
      setConfig(newConfig);
      // Another small delay before switching screens
      await new Promise(resolve => setTimeout(resolve, 50));
      setIsConfigured(true);
      // Debug removed
    } catch (e: any) {
      console.error('Failed to save config:', e);
      Alert.alert('Error', `Failed to save configuration.\n\nDetails: ${e.message || e.toString()}\n\nPlease try again.`);
    }
  };

  const changeVoice = async (voice: string) => {
    if (!config) return;
    const newConfig = { ...config, voice };
    await AsyncStorage.setItem('voice', voice);
    setConfig(newConfig);
  };

  const toggleTts = async () => {
    if (!config) return;
    const newValue = !config.ttsEnabled;
    const newConfig = { ...config, ttsEnabled: newValue };
    await AsyncStorage.setItem('ttsEnabled', String(newValue));
    setConfig(newConfig);
    // If turning TTS off mid-playback, stop any audio immediately.
    if (!newValue) {
      await stopAudioPlayback();
    }
    // The tts flag is sent with each text/audio message, so the server
    // picks up the new preference on the next turn automatically.
  };

  const [isUploading, setIsUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState<{ uri: string; name: string; mimeType?: string } | null>(null);
  const [uploadInstruction, setUploadInstruction] = useState('');

  const connect = useCallback(async () => {
    if (!config) return;
    
    // Enable auto-reconnect
    shouldReconnectRef.current = true;

    try {
      // Request audio permissions
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission required', 'Microphone access is needed for voice chat');
        return;
      }

      // Configure audio mode
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      });

      // Connect WebSocket
      // Server expects /ws path for WebSocket
      const baseUrl = config.serverUrl.replace('/api/voice', '').replace(/^http/, 'ws');
      const wsUrl = baseUrl + '/api/voice/ws';
      // Debug removed

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        // Debug removed
        reconnectAttemptsRef.current = 0; // Reset on successful connect
        setError(null);
        // Send auth
        ws.send(JSON.stringify({
          type: 'auth',
          token: config.token,
          sessionKey: config.sessionKey,
          tts: config.ttsEnabled !== false,
        }));
      };

      ws.onmessage = async (event) => {
        // Check if it's binary audio data
        if (typeof event.data !== 'string') {
          // Debug removed
          playAudio(event.data);
          return;
        }
        
        // JSON message
        try {
          const data = JSON.parse(event.data);
          handleMessage(data);
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      };

      ws.onerror = (e) => {
        console.error('WebSocket error:', e);
        setError('Connection error');
        setIsConnected(false);
      };

      ws.onclose = () => {
        // Debug removed
        setIsConnected(false);
        wsRef.current = null;
        
        // Auto-reconnect if not intentionally disconnected
        if (shouldReconnectRef.current && reconnectAttemptsRef.current < maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
          // Debug removed
          setError(`Connection lost. Reconnecting...`);
          
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttemptsRef.current++;
            connect();
          }, delay);
        } else if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
          setError('Connection lost. Tap Connect to retry.');
        }
      };

      wsRef.current = ws;
    } catch (e) {
      console.error('Connection failed:', e);
      setError('Failed to connect');
    }
  }, [config]);

  const disconnect = () => {
    shouldReconnectRef.current = false;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    setIsConnected(false);
    setError(null);
  };

  const logout = () => {
    Alert.alert(
      'Logout',
      'This will clear your settings. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            // Stop any audio first
            await stopAudioPlayback();
            // Run logout
            disconnect();
            setConfig(null);
            setIsConfigured(false);
            setMessages([]);
            setCurrentTranscript('');
            setIsProcessing(false);
            // Clear storage in background
            AsyncStorage.multiRemove(['serverUrl', 'token', 'sessionKey', 'voice'])
              .catch(e => console.error('Failed to clear storage:', e));
          },
        },
      ]
    );
  };

  const handleMessage = (data: any) => {
    switch (data.type) {
      case 'authenticated':
        setIsConnected(true);
        setError(null);
        break;

      case 'auth_error':
        setError(data.message || 'Authentication failed');
        wsRef.current?.close();
        break;

      case 'transcript':
        setCurrentTranscript(data.text);
        break;

      case 'transcript_final':
        addMessage('user', data.text);
        setCurrentTranscript('');
        setIsProcessing(true);
        break;

      case 'response_start':
        // Drop any stale audio still queued from a previous/interrupted turn.
        audioQueueRef.current = [];
        setIsProcessing(false);
        setIsSpeaking(true);
        break;

      case 'response_text':
        // Streaming text response
        updateLastAssistantMessage(data.text, data.final);
        break;

      case 'response_end':
        setIsSpeaking(false);
        break;

      case 'error':
        setError(data.message);
        setIsProcessing(false);
        setIsSpeaking(false);
        break;
    }
  };

  const addMessage = (role: 'user' | 'assistant', content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        role,
        content,
        timestamp: new Date(),
      },
    ]);
  };

  const updateLastAssistantMessage = (content: string, isFinal: boolean) => {
    setMessages((prev) => {
      const lastMsg = prev[prev.length - 1];
      if (lastMsg?.role === 'assistant' && !isFinal) {
        // Update existing
        return [
          ...prev.slice(0, -1),
          { ...lastMsg, content: lastMsg.content + content },
        ];
      } else if (isFinal) {
        // Final message
        return prev;
      } else {
        // Start new assistant message
        return [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content,
            timestamp: new Date(),
          },
        ];
      }
    });
  };

  // Convert audio data to a base64 data URI without blocking the JS thread.
  // ArrayBuffers are converted in 16KB chunks inside setImmediate so streaming
  // TTS chunks don't freeze the UI while a long clip is encoded.
  const audioToBase64 = (audioData: Blob | ArrayBuffer): Promise<string | null> => {
    if (audioData instanceof Blob) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(audioData);
      });
    }

    return new Promise((resolve) => {
      setImmediate(() => {
        try {
          const bytes = new Uint8Array(audioData);
          let binary = '';
          const chunkSize = 16384;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
            let chunkBinary = '';
            for (let j = 0; j < chunk.length; j++) {
              chunkBinary += String.fromCharCode(chunk[j]);
            }
            binary += chunkBinary;
          }
          resolve('data:audio/mpeg;base64,' + btoa(binary));
        } catch (e) {
          console.error('Failed to convert audio:', e);
          resolve(null);
        }
      });
    });
  };

  // Stop all audio playback and reset state
  const stopAudioPlayback = async () => {
    // Clear queue
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    
    // Stop and unload current sound
    if (soundRef.current) {
      try {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
      } catch (e) {}
      soundRef.current = null;
    }
    
    setIsSpeaking(false);
  };

  // Process audio queue sequentially
  const processAudioQueue = async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) {
      return;
    }

    isPlayingRef.current = true;
    setIsSpeaking(true);

    // Set audio mode for playback (works for both iOS and Android)
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
    } catch (e) {
      console.error('Failed to set audio mode:', e);
    }

    while (audioQueueRef.current.length > 0 && isPlayingRef.current) {
      const base64 = await audioQueueRef.current.shift()!;
      if (!base64) continue;

      try {
        // Unload previous sound
        if (soundRef.current) {
          try {
            await soundRef.current.unloadAsync();
          } catch (e) {}
          soundRef.current = null;
        }

        // Create and play sound
        const { sound } = await Audio.Sound.createAsync(
          { uri: base64 },
          { shouldPlay: true }
        );
        soundRef.current = sound;

        // Wait for playback to complete with timeout
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            // Debug removed
            resolve();
          }, 30000); // 30 second max per chunk
          
          sound.setOnPlaybackStatusUpdate((status) => {
            if (status.isLoaded && status.didJustFinish) {
              clearTimeout(timeout);
              resolve();
            }
            // Also resolve on error
            if (!status.isLoaded && 'error' in status) {
              clearTimeout(timeout);
              console.error('Audio playback error:', status);
              resolve();
            }
          });
        });
        
      } catch (e) {
        console.error('Failed to play audio chunk:', e);
      }
    }

    isPlayingRef.current = false;
    setIsSpeaking(false);
    
    // Clean up last sound
    if (soundRef.current) {
      try {
        await soundRef.current.unloadAsync();
      } catch (e) {}
      soundRef.current = null;
    }
  };

  // Queue audio for playback. The conversion promise is queued immediately so
  // chunks keep their arrival order while encoding happens in the background.
  const playAudio = (audioData: Blob | ArrayBuffer) => {
    audioQueueRef.current.push(audioToBase64(audioData));
    processAudioQueue();
  };

  const startRecording = async () => {
    try {
      setError(null);

      // Check if connected
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        setError('Not connected');
        return;
      }

      // Stop any playing audio first
      if (soundRef.current) {
        try {
          await soundRef.current.stopAsync();
          await soundRef.current.unloadAsync();
        } catch (e) {
          // Ignore errors when stopping
        }
        soundRef.current = null;
      }

      // Request permissions
      // Debug removed
      const permResponse = await Audio.requestPermissionsAsync();
      if (permResponse.status !== 'granted') {
        setError('Microphone permission required');
        return;
      }

      // Set audio mode for recording
      // Debug removed
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });

      // Use the preset - more reliable than custom options
      // Debug removed
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      // Debug removed
      recordingRef.current = recording;
      setIsRecording(true);

      // Notify server
      wsRef.current.send(JSON.stringify({ type: 'recording_start' }));
    } catch (e: any) {
      console.error('Failed to start recording:', e);
      setError(`Recording error: ${e.message}`);
    }
  };

  const stopRecording = async () => {
    try {
      if (!recordingRef.current) return;

      setIsRecording(false);
      setIsProcessing(true);

      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;

      if (uri && wsRef.current?.readyState === WebSocket.OPEN) {
        // Read audio file and send
        const response = await fetch(uri);
        const blob = await response.blob();
        
        // Convert to base64 for sending
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          wsRef.current?.send(JSON.stringify({
            type: 'audio',
            data: base64,
            format: Platform.OS === 'web' ? 'webm' : 'm4a',
            voice: config?.voice || 'nova',
            tts: config?.ttsEnabled !== false,
          }));
        };
        reader.readAsDataURL(blob);
      }
    } catch (e) {
      console.error('Failed to stop recording:', e);
      setError('Failed to process recording');
      setIsProcessing(false);
    }
  };

  // Tap-to-toggle mic: first tap starts recording, second tap stops & sends.
  const toggleRecording = async () => {
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  };

  const sendTextMessage = async () => {
    const text = textInput.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (isProcessing || isSpeaking) return;

    // Clear input and add message
    setTextInput('');
    setInputHeight(0);
    addMessage('user', text);
    setIsProcessing(true);

    // Send text message to server
    wsRef.current.send(JSON.stringify({
      type: 'text',
      text: text,
      voice: config?.voice || 'nova',
      tts: config?.ttsEnabled !== false,
    }));
  };

  // Pick a file to upload; on success open the instruction modal.
  const pickFileForUpload = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      // Client-side grootte-check (server staat max 150MB toe).
      const MAX_UPLOAD_MB = 150;
      if (typeof asset.size === 'number' && asset.size > MAX_UPLOAD_MB * 1024 * 1024) {
        setError(`Bestand te groot (${(asset.size / 1048576).toFixed(0)} MB). Max ${MAX_UPLOAD_MB} MB.`);
        return;
      }
      setUploadFile({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType });
      setUploadInstruction('');
    } catch (e: any) {
      setError(`Kon bestand niet kiezen: ${e.message}`);
    }
  };

  // Send the picked file + instruction to the server upload endpoint.
  const submitUpload = async () => {
    if (!uploadFile || !config) return;
    setIsUploading(true);
    try {
      const base64 = await FileSystem.readAsStringAsync(uploadFile.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const uploadUrl = config.serverUrl.replace(/\/$/, '') + '/upload';
      const instruction = uploadInstruction.trim();

      // Show the action in the chat immediately.
      addMessage('user', `📎 ${uploadFile.name}${instruction ? `\n\n${instruction}` : ''}`);
      const fileToSend = uploadFile;
      setUploadFile(null);
      setUploadInstruction('');
      setIsProcessing(true);

      const resp = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: config.token,
          sessionKey: config.sessionKey,
          filename: fileToSend.name,
          instruction,
          data: base64,
          voice: config.voice,
        }),
      });
      const json = await resp.json();
      setIsProcessing(false);
      if (!resp.ok || json.error) {
        setError(`Upload mislukt: ${json.error || resp.status}`);
      } else if (json.response) {
        addMessage('assistant', json.response);
      } else {
        addMessage('assistant', 'Bestand ontvangen en opgeslagen.');
      }
    } catch (e: any) {
      setIsProcessing(false);
      setError(`Upload mislukt: ${e.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  // Config screen
  if (!isConfigured) {
    return <ConfigScreen onSave={saveConfig} />;
  }

  // Main screen
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView 
        style={styles.keyboardAvoid}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setShowSettings(true)}>
          <Text style={styles.headerTitle}>🦉 Thriphon</Text>
        </TouchableOpacity>
        <View style={styles.headerRight}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: isConnected ? '#4CAF50' : '#666' },
            ]}
          />
          <TouchableOpacity
            onPress={isConnected ? disconnect : connect}
            style={styles.connectButton}
          >
            <Text style={styles.connectButtonText}>
              {isConnected ? 'Disconnect' : 'Connect'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Settings Modal */}
      {showSettings && (
        <View style={styles.settingsOverlay}>
          <View style={styles.settingsModal}>
            <Text style={styles.settingsTitle}>⚙️ Settings</Text>
            
            <View style={styles.settingsInfo}>
              <Text style={styles.settingsLabel}>Server</Text>
              <Text style={styles.settingsValue}>{config?.serverUrl}</Text>
            </View>
            
            <View style={styles.settingsInfo}>
              <Text style={styles.settingsLabel}>Session</Text>
              <Text style={styles.settingsValue}>{config?.sessionKey}</Text>
            </View>

            <View style={styles.settingsInfo}>
              <Text style={styles.settingsLabel}>Status</Text>
              <Text style={[styles.settingsValue, { color: isConnected ? '#4CAF50' : '#ff6b6b' }]}>
                {isConnected ? '● Connected' : '○ Disconnected'}
              </Text>
            </View>

            <View style={styles.settingsInfo}>
              <View style={styles.ttsRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingsLabel}>Voice-terugkoppeling</Text>
                  <Text style={styles.ttsHint}>
                    {config?.ttsEnabled !== false
                      ? 'Antwoorden worden voorgelezen'
                      : 'Alleen tekst (sneller lezen)'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.toggle, config?.ttsEnabled !== false && styles.toggleOn]}
                  onPress={toggleTts}
                >
                  <View style={[styles.toggleKnob, config?.ttsEnabled !== false && styles.toggleKnobOn]} />
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.settingsInfo}>
              <Text style={styles.settingsLabel}>Voice</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.voiceSelector}>
                {AVAILABLE_VOICES.map((v) => (
                  <TouchableOpacity
                    key={v.id}
                    style={[
                      styles.voiceOption,
                      config?.voice === v.id && styles.voiceOptionSelected,
                    ]}
                    onPress={() => changeVoice(v.id)}
                  >
                    <Text style={[
                      styles.voiceOptionName,
                      config?.voice === v.id && styles.voiceOptionNameSelected,
                    ]}>{v.name}</Text>
                    <Text style={styles.voiceOptionDesc}>{v.description}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <TouchableOpacity
              style={styles.settingsButton}
              onPress={async () => {
                await stopAudioPlayback();
                setMessages([]);
                setCurrentTranscript('');
                setIsProcessing(false);
                setShowSettings(false);
              }}
            >
              <Text style={styles.settingsButtonText}>Clear Chat History</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.settingsButton, styles.logoutButton]}
              onPress={() => {
                setShowSettings(false);
                logout();
              }}
            >
              <Text style={styles.settingsButtonText}>Logout & Reset</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setShowSettings(false)}
            >
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Error banner */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Messages */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
      >
        {messages.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateEmoji}>🦉</Text>
            <Text style={styles.emptyStateText}>
              {isConnected
                ? 'Tap the mic to start, tap again to send'
                : 'Tap Connect to start'}
            </Text>
          </View>
        )}
        {messages.map((msg) => (
          <View
            key={`${msg.id}-${msg.content.length}`}
            style={[
              styles.message,
              msg.role === 'user' ? styles.userMessage : styles.assistantMessage,
            ]}
          >
            {msg.role === 'assistant' ? (
              <ChatMarkdown content={msg.content} />
            ) : (
              <Text style={[styles.messageText, styles.userMessageText]}>
                {msg.content}
              </Text>
            )}
          </View>
        ))}
        {currentTranscript && (
          <View style={[styles.message, styles.userMessage, styles.transcribing]}>
            <Text style={styles.userMessageText}>{currentTranscript}...</Text>
          </View>
        )}
        {isProcessing && (
          <View style={[styles.message, styles.assistantMessage]}>
            <Text style={styles.assistantMessageText}>Thinking...</Text>
          </View>
        )}
      </ScrollView>

      {/* Upload instruction modal */}
      {uploadFile && (
        <View style={styles.settingsOverlay}>
          <View style={styles.settingsModal}>
            <Text style={styles.settingsTitle}>📎 Bestand uploaden</Text>
            <View style={styles.settingsInfo}>
              <Text style={styles.settingsLabel}>Bestand</Text>
              <Text style={styles.settingsValue}>{uploadFile.name}</Text>
            </View>
            <View style={styles.settingsInfo}>
              <Text style={styles.settingsLabel}>Instructie (optioneel)</Text>
              <TextInput
                style={styles.uploadInstructionInput}
                value={uploadInstruction}
                onChangeText={setUploadInstruction}
                placeholder="Bijv: maak een gespreksverslag, analyseer deze PowerPoint, of sla op voor later"
                placeholderTextColor="#666"
                multiline
              />
            </View>
            <TouchableOpacity
              style={[styles.settingsButton, isUploading && { opacity: 0.5 }]}
              onPress={submitUpload}
              disabled={isUploading}
            >
              <Text style={styles.settingsButtonText}>{isUploading ? 'Uploaden...' : 'Verstuur'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => { setUploadFile(null); setUploadInstruction(''); }}
              disabled={isUploading}
            >
              <Text style={styles.closeButtonText}>Annuleer</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Text input */}
      <View style={styles.textInputContainer}>
        <TouchableOpacity
          style={styles.uploadButton}
          onPress={pickFileForUpload}
          disabled={!isConnected || isProcessing || isSpeaking || isRecording}
        >
          <Text style={styles.uploadButtonIcon}>📎</Text>
        </TouchableOpacity>
        <TextInput
          style={[
            styles.textInputField,
            { height: Math.min(Math.max(44, inputHeight), 140) },
          ]}
          value={textInput}
          onChangeText={setTextInput}
          onContentSizeChange={(e) =>
            setInputHeight(e.nativeEvent.contentSize.height + 20)
          }
          placeholder="Type a message..."
          placeholderTextColor="#666"
          editable={isConnected && !isProcessing && !isSpeaking && !isRecording}
          multiline
        />
        {textInput.trim() ? (
          <TouchableOpacity
            style={styles.sendButton}
            onPress={sendTextMessage}
            disabled={!isConnected || isProcessing || isSpeaking}
          >
            <Text style={styles.sendButtonText}>↑</Text>
          </TouchableOpacity>
        ) : (
          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <TouchableOpacity
              onPress={toggleRecording}
              disabled={!isConnected || isProcessing || isSpeaking}
              style={[
                styles.micButton,
                isRecording && styles.micButtonActive,
                (!isConnected || isProcessing || isSpeaking) &&
                  styles.micButtonDisabled,
              ]}
            >
              <Text style={styles.micButtonIcon}>
                {isRecording ? '🔴' : isSpeaking ? '🔊' : isProcessing ? '⏳' : '🎤'}
              </Text>
            </TouchableOpacity>
          </Animated.View>
        )}
      </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// Config Screen Component
function ConfigScreen({ onSave }: { onSave: (config: Config) => void }) {
  const [serverUrl, setServerUrl] = useState('https://thriphon.cloud/api/voice');
  const [token, setToken] = useState('');
  const [sessionKey, setSessionKey] = useState('voice:mobile');

  const handleSave = () => {
    if (!serverUrl || !token) {
      Alert.alert('Error', 'Server URL and Token are required');
      return;
    }
    onSave({ serverUrl, token, sessionKey, voice: 'nova', ttsEnabled: true });
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.configContainer}>
        <Text style={styles.configTitle}>🦉 OpenClaw Voice</Text>
        <Text style={styles.configSubtitle}>Connect to your assistant</Text>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Server URL</Text>
          <TextInput
            style={styles.input}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="https://your-server.com/api/voice"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Gateway Token</Text>
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            placeholder="Your gateway token"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Session Key (optional)</Text>
          <TextInput
            style={styles.input}
            value={sessionKey}
            onChangeText={setSessionKey}
            placeholder="voice:mobile"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
          <Text style={styles.saveButtonText}>Connect</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// Styles
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
  keyboardAvoid: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
    paddingTop: Platform.OS === 'android' ? 45 : 15,
    borderBottomWidth: 1,
    borderBottomColor: '#2d2d44',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  connectButton: {
    paddingHorizontal: 15,
    paddingVertical: 8,
    backgroundColor: '#4a4a6a',
    borderRadius: 20,
  },
  connectButtonText: {
    color: '#fff',
    fontSize: 14,
  },
  errorBanner: {
    backgroundColor: '#ff4444',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  errorText: {
    color: '#fff',
    textAlign: 'center',
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    padding: 20,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 100,
  },
  emptyStateEmoji: {
    fontSize: 60,
    marginBottom: 20,
  },
  emptyStateText: {
    color: '#888',
    fontSize: 16,
  },
  message: {
    maxWidth: '80%',
    marginBottom: 12,
    padding: 14,
    borderRadius: 18,
  },
  userMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#5c6bc0',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    backgroundColor: '#2d2d44',
  },
  transcribing: {
    opacity: 0.7,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  userMessageText: {
    color: '#fff',
  },
  assistantMessageText: {
    color: '#e0e0e0',
  },
  // Text input container
  textInputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    paddingBottom: Platform.OS === 'android' ? 60 : Platform.OS === 'ios' ? 24 : 10,
    borderTopWidth: 1,
    borderTopColor: '#2d2d44',
    backgroundColor: '#1a1a2e',
    gap: 8,
  },
  textInputField: {
    flex: 1,
    backgroundColor: '#2d2d44',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    color: '#fff',
    fontSize: 16,
    textAlignVertical: 'center',
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#5c6bc0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: 'bold',
  },
  micButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#5c6bc0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  uploadButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#3d3d5c',
    justifyContent: 'center',
    alignItems: 'center',
  },
  uploadButtonIcon: {
    fontSize: 20,
  },
  uploadInstructionInput: {
    backgroundColor: '#3d3d5c',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#fff',
    fontSize: 15,
    minHeight: 70,
    textAlignVertical: 'top',
    marginTop: 6,
  },
  ttsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  ttsHint: {
    color: '#aaa',
    fontSize: 12,
    marginTop: 2,
  },
  toggle: {
    width: 52,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#555',
    padding: 3,
    justifyContent: 'center',
  },
  toggleOn: {
    backgroundColor: '#5c6bc0',
  },
  toggleKnob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#fff',
    alignSelf: 'flex-start',
  },
  toggleKnobOn: {
    alignSelf: 'flex-end',
  },
  micButtonActive: {
    backgroundColor: '#e53935',
  },
  micButtonDisabled: {
    backgroundColor: '#333',
    opacity: 0.6,
  },
  micButtonIcon: {
    fontSize: 20,
  },
  // Config screen styles
  configContainer: {
    flex: 1,
    padding: 30,
    justifyContent: 'center',
  },
  configTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 10,
  },
  configSubtitle: {
    fontSize: 16,
    color: '#888',
    textAlign: 'center',
    marginBottom: 40,
  },
  inputGroup: {
    marginBottom: 20,
  },
  inputLabel: {
    color: '#aaa',
    marginBottom: 8,
    fontSize: 14,
  },
  input: {
    backgroundColor: '#2d2d44',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#fff',
    fontSize: 16,
  },
  saveButton: {
    backgroundColor: '#5c6bc0',
    borderRadius: 12,
    paddingVertical: 16,
    marginTop: 20,
  },
  saveButtonText: {
    color: '#fff',
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '600',
  },
  // Settings modal styles
  settingsOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  settingsModal: {
    backgroundColor: '#2d2d44',
    borderRadius: 20,
    padding: 24,
    width: '85%',
    maxWidth: 400,
  },
  settingsTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 20,
  },
  settingsInfo: {
    marginBottom: 16,
  },
  settingsLabel: {
    color: '#888',
    fontSize: 12,
    marginBottom: 4,
  },
  settingsValue: {
    color: '#fff',
    fontSize: 14,
  },
  settingsButton: {
    backgroundColor: '#4a4a6a',
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 12,
  },
  settingsButtonText: {
    color: '#fff',
    textAlign: 'center',
    fontSize: 16,
  },
  logoutButton: {
    backgroundColor: '#c0392b',
  },
  closeButton: {
    marginTop: 16,
    paddingVertical: 12,
  },
  closeButtonText: {
    color: '#888',
    textAlign: 'center',
    fontSize: 16,
  },
  voiceSelector: {
    marginTop: 8,
    marginHorizontal: -8,
  },
  voiceOption: {
    backgroundColor: '#3d3d5c',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginHorizontal: 4,
    minWidth: 100,
    alignItems: 'center',
  },
  voiceOptionSelected: {
    backgroundColor: '#5c6bc0',
  },
  voiceOptionName: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  voiceOptionNameSelected: {
    color: '#fff',
  },
  voiceOptionDesc: {
    color: '#aaa',
    fontSize: 11,
    marginTop: 2,
  },
});

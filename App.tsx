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
} from 'react-native';
import { Audio } from 'expo-av';
import * as SecureStore from 'expo-secure-store';

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
}

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

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  
  // Audio queue for sequential playback
  const audioQueueRef = useRef<string[]>([]);
  const isPlayingRef = useRef(false);

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
      const serverUrl = await SecureStore.getItemAsync('serverUrl');
      const token = await SecureStore.getItemAsync('token');
      const sessionKey = await SecureStore.getItemAsync('sessionKey');

      if (serverUrl && token) {
        setConfig({
          serverUrl,
          token,
          sessionKey: sessionKey || 'voice:mobile',
        });
        setIsConfigured(true);
      }
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  };

  const saveConfig = async (newConfig: Config) => {
    try {
      await SecureStore.setItemAsync('serverUrl', newConfig.serverUrl);
      await SecureStore.setItemAsync('token', newConfig.token);
      await SecureStore.setItemAsync('sessionKey', newConfig.sessionKey);
      setConfig(newConfig);
      setIsConfigured(true);
    } catch (e) {
      console.error('Failed to save config:', e);
      Alert.alert('Error', 'Failed to save configuration');
    }
  };

  const connect = useCallback(async () => {
    if (!config) return;

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
      console.log('Connecting to:', wsUrl);

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('WebSocket connected');
        // Send auth
        ws.send(JSON.stringify({
          type: 'auth',
          token: config.token,
          sessionKey: config.sessionKey,
        }));
      };

      ws.onmessage = async (event) => {
        // Check if it's binary audio data
        if (typeof event.data !== 'string') {
          console.log('Received binary audio data:', event.data.byteLength || event.data.size, 'bytes');
          await playAudio(event.data);
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
        console.log('WebSocket closed');
        setIsConnected(false);
      };

      wsRef.current = ws;
    } catch (e) {
      console.error('Connection failed:', e);
      setError('Failed to connect');
    }
  }, [config]);

  const disconnect = () => {
    wsRef.current?.close();
    wsRef.current = null;
    setIsConnected(false);
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

  // Convert audio data to base64 URI
  const audioToBase64 = async (audioData: Blob | ArrayBuffer): Promise<string | null> => {
    try {
      if (audioData instanceof ArrayBuffer) {
        const bytes = new Uint8Array(audioData);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return 'data:audio/mpeg;base64,' + btoa(binary);
      } else if (audioData instanceof Blob) {
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(audioData);
        });
      }
      return null;
    } catch (e) {
      console.error('Failed to convert audio:', e);
      return null;
    }
  };

  // Process audio queue sequentially
  const processAudioQueue = async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) {
      return;
    }

    isPlayingRef.current = true;
    setIsSpeaking(true);

    // Set audio mode for playback
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
    });

    while (audioQueueRef.current.length > 0) {
      const base64 = audioQueueRef.current.shift()!;
      
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

        // Wait for playback to complete
        await new Promise<void>((resolve) => {
          sound.setOnPlaybackStatusUpdate((status) => {
            if (status.isLoaded && status.didJustFinish) {
              resolve();
            }
          });
        });

        // Small gap between sentences
        await new Promise(r => setTimeout(r, 50));
        
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

  // Queue audio for playback
  const playAudio = async (audioData: Blob | ArrayBuffer) => {
    const base64 = await audioToBase64(audioData);
    if (base64) {
      console.log('Queuing audio chunk, queue size:', audioQueueRef.current.length + 1);
      audioQueueRef.current.push(base64);
      processAudioQueue();
    }
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
      console.log('Requesting permissions...');
      const permResponse = await Audio.requestPermissionsAsync();
      if (permResponse.status !== 'granted') {
        setError('Microphone permission required');
        return;
      }

      // Set audio mode for recording
      console.log('Setting audio mode...');
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });

      // Use the preset - more reliable than custom options
      console.log('Creating recording...');
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      console.log('Recording started!');
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

  // Config screen
  if (!isConfigured) {
    return <ConfigScreen onSave={saveConfig} />;
  }

  // Main screen
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>🦉 Thriphon</Text>
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
                ? 'Hold the button to talk'
                : 'Tap Connect to start'}
            </Text>
          </View>
        )}
        {messages.map((msg) => (
          <View
            key={msg.id}
            style={[
              styles.message,
              msg.role === 'user' ? styles.userMessage : styles.assistantMessage,
            ]}
          >
            <Text
              style={[
                styles.messageText,
                msg.role === 'user'
                  ? styles.userMessageText
                  : styles.assistantMessageText,
              ]}
            >
              {msg.content}
            </Text>
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

      {/* Push to talk button */}
      <View style={styles.controls}>
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <TouchableOpacity
            onPressIn={startRecording}
            onPressOut={stopRecording}
            disabled={!isConnected || isProcessing || isSpeaking}
            style={[
              styles.recordButton,
              isRecording && styles.recordButtonActive,
              (!isConnected || isProcessing || isSpeaking) &&
                styles.recordButtonDisabled,
            ]}
          >
            <Text style={styles.recordButtonIcon}>
              {isRecording ? '🔴' : isSpeaking ? '🔊' : isProcessing ? '⏳' : '🎤'}
            </Text>
            <Text style={styles.recordButtonText}>
              {isRecording
                ? 'Listening...'
                : isSpeaking
                ? 'Speaking...'
                : isProcessing
                ? 'Processing...'
                : 'Hold to Talk'}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
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
    onSave({ serverUrl, token, sessionKey });
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
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
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
  controls: {
    paddingVertical: 30,
    paddingHorizontal: 20,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#2d2d44',
  },
  recordButton: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: '#4a4a6a',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  recordButtonActive: {
    backgroundColor: '#e53935',
  },
  recordButtonDisabled: {
    backgroundColor: '#333',
    opacity: 0.6,
  },
  recordButtonIcon: {
    fontSize: 40,
    marginBottom: 8,
  },
  recordButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
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
});
